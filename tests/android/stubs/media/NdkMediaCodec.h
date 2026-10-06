// Syntax-check stub of the NDK's <media/NdkMediaCodec.h> (see NdkMediaFormat.h).
#pragma once
#include <stdint.h>
#include <sys/types.h>
#include "NdkMediaFormat.h"
#ifdef __cplusplus
extern "C" {
#endif
struct ANativeWindow;
struct AMediaCrypto;
typedef struct AMediaCrypto AMediaCrypto;
struct AMediaCodec;
typedef struct AMediaCodec AMediaCodec;
typedef struct AMediaCodecBufferInfo { int32_t offset; int32_t size; int64_t presentationTimeUs; uint32_t flags; } AMediaCodecBufferInfo;
enum {
    AMEDIACODEC_BUFFER_FLAG_CODEC_CONFIG = 2,
    AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM = 4,
    AMEDIACODEC_CONFIGURE_FLAG_ENCODE = 1,
    AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED = -3,
    AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED = -2,
    AMEDIACODEC_INFO_TRY_AGAIN_LATER = -1,
};
AMediaCodec* AMediaCodec_createEncoderByType(const char* mime_type);
AMediaCodec* AMediaCodec_createDecoderByType(const char* mime_type);
media_status_t AMediaCodec_delete(AMediaCodec*);
media_status_t AMediaCodec_configure(AMediaCodec*, const AMediaFormat* format, ANativeWindow* surface, AMediaCrypto* crypto, uint32_t flags);
media_status_t AMediaCodec_start(AMediaCodec*);
media_status_t AMediaCodec_stop(AMediaCodec*);
ssize_t AMediaCodec_dequeueInputBuffer(AMediaCodec*, int64_t timeoutUs);
uint8_t* AMediaCodec_getInputBuffer(AMediaCodec*, size_t idx, size_t* out_size);
media_status_t AMediaCodec_queueInputBuffer(AMediaCodec*, size_t idx, off_t offset, size_t size, uint64_t time, uint32_t flags);
ssize_t AMediaCodec_dequeueOutputBuffer(AMediaCodec*, AMediaCodecBufferInfo* info, int64_t timeoutUs);
uint8_t* AMediaCodec_getOutputBuffer(AMediaCodec*, size_t idx, size_t* out_size);
AMediaFormat* AMediaCodec_getOutputFormat(AMediaCodec*);
media_status_t AMediaCodec_releaseOutputBuffer(AMediaCodec*, size_t idx, bool render);
media_status_t AMediaCodec_setParameters(AMediaCodec*, const AMediaFormat* params);
#ifdef __cplusplus
}
#endif
