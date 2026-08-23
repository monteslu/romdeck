// The H.264 decoder shim.
//
// Deliberately tiny: feed it Annex-B, get RGBA back. Everything structural
// (container parsing, sample timing, looping) is JS, because that work is
// pure bookkeeping and does not need native code -- see mp4.js.
//
// Colour conversion happens here rather than in a shader for v1. It is one
// pass over the frame and keeps the GL path free of a YUV special case; if it
// ever shows up in a profile, the plane pointers are already exported and a
// shader can take over without touching the JS side.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <libavcodec/avcodec.h>

static AVCodecContext *ctx = NULL;
static AVPacket *pkt = NULL;
static AVFrame *frame = NULL;
static uint8_t *rgba = NULL;
static int rgba_cap = 0;

int h264_open(void) {
    const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_H264);
    if (!codec) return -1;
    ctx = avcodec_alloc_context3(codec);
    if (!ctx) return -2;
    // Snaps are short and we decode ahead a few frames; one thread keeps the
    // WASM build simple and avoids pthread requirements entirely.
    ctx->thread_count = 1;
    if (avcodec_open2(ctx, codec, NULL) < 0) return -3;
    pkt = av_packet_alloc();
    frame = av_frame_alloc();
    return (pkt && frame) ? 0 : -4;
}

static inline uint8_t clamp8(int v) {
    return v < 0 ? 0 : (v > 255 ? 255 : (uint8_t)v);
}

/**
 * YUV420 planar -> RGBA, honouring the frame's colour RANGE.
 *
 * Real snaps come in both: broadcast/limited (Y 16-235) and full/JPEG
 * (Y 0-255, historically the YUVJ420P format). Applying the limited-range
 * matrix to a full-range frame crushes blacks and clips highlights, so the
 * range is read from the frame rather than assumed -- the assumption is what
 * made the first version reject half its input outright.
 */
static void yuv_to_rgba(const AVFrame *f, int full_range, int sub_x, int sub_y) {
    int w = f->width, h = f->height;
    int need = w * h * 4;
    if (need > rgba_cap) {
        free(rgba);
        rgba = (uint8_t *)malloc(need);
        rgba_cap = need;
    }
    if (!rgba) return;

    for (int y = 0; y < h; y++) {
        const uint8_t *Y = f->data[0] + y * f->linesize[0];
        const uint8_t *U = f->data[1] + (y >> sub_y) * f->linesize[1];
        const uint8_t *V = f->data[2] + (y >> sub_y) * f->linesize[2];
        uint8_t *out = rgba + y * w * 4;
        for (int x = 0; x < w; x++) {
            int d = U[x >> sub_x] - 128;
            int e = V[x >> sub_x] - 128;
            if (full_range) {
                int c = Y[x];
                out[0] = clamp8(c + ((91881 * e) >> 16));
                out[1] = clamp8(c - ((22554 * d + 46802 * e) >> 16));
                out[2] = clamp8(c + ((116130 * d) >> 16));
            } else {
                int c = Y[x] - 16;
                out[0] = clamp8((298 * c + 409 * e + 128) >> 8);
                out[1] = clamp8((298 * c - 100 * d - 208 * e + 128) >> 8);
                out[2] = clamp8((298 * c + 516 * d + 128) >> 8);
            }
            out[3] = 255;
            out += 4;
        }
    }
}

/**
 * Decode one Annex-B access unit.
 * @return 1 when a frame is ready, 0 when more data is needed, <0 on error.
 */
int h264_decode(const uint8_t *data, int size) {
    if (!ctx) return -1;
    // A packet must be padded: the bitstream reader over-reads by design, and
    // an unpadded buffer makes it walk into whatever follows -- which shows up
    // as "decode_slice_header error / no frame" on perfectly valid input
    // rather than as a crash. This cost an hour; ffmpeg documents the
    // requirement, and it is the single most common way to misuse the API.
    if (av_new_packet(pkt, size) < 0) return -10;
    memcpy(pkt->data, data, size);
    int rc = avcodec_send_packet(ctx, pkt);
    av_packet_unref(pkt);
    if (rc < 0 && rc != AVERROR(EAGAIN)) return rc;
    rc = avcodec_receive_frame(ctx, frame);
    if (rc == AVERROR(EAGAIN) || rc == AVERROR_EOF) return 0;
    if (rc < 0) return rc;
    // Handle every planar YUV layout H.264 actually produces, rather than
    // assuming 4:2:0. Real encoders emit 4:2:2 and 4:4:4 too, and hardcoding
    // the chroma shift silently mangles those -- a check that only accepted
    // 4:2:0 rejected a perfectly good 4:4:4 clip outright.
    //
    // The J-suffixed formats are the deprecated full-range spelling; both
    // they and color_range mark the same thing.
    int sub_x, sub_y;
    switch (frame->format) {
        case AV_PIX_FMT_YUV420P: case AV_PIX_FMT_YUVJ420P: sub_x = 1; sub_y = 1; break;
        case AV_PIX_FMT_YUV422P: case AV_PIX_FMT_YUVJ422P: sub_x = 1; sub_y = 0; break;
        case AV_PIX_FMT_YUV444P: case AV_PIX_FMT_YUVJ444P: sub_x = 0; sub_y = 0; break;
        // Anything else (10-bit, hardware surfaces): the caller falls back to
        // the static image. Encoded into the code so it stays diagnosable.
        default: return -1000 - frame->format;
    }
    int full = (frame->format == AV_PIX_FMT_YUVJ420P)
            || (frame->format == AV_PIX_FMT_YUVJ422P)
            || (frame->format == AV_PIX_FMT_YUVJ444P)
            || (frame->color_range == AVCOL_RANGE_JPEG);
    yuv_to_rgba(frame, full, sub_x, sub_y);
    return 1;
}

uint8_t *h264_frame_ptr(void) { return rgba; }
int h264_width(void) { return frame ? frame->width : 0; }
int h264_height(void) { return frame ? frame->height : 0; }

void h264_close(void) {
    if (ctx) avcodec_free_context(&ctx);
    if (pkt) av_packet_free(&pkt);
    if (frame) av_frame_free(&frame);
    free(rgba);
    rgba = NULL;
    rgba_cap = 0;
}
