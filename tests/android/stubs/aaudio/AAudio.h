#pragma once
#include <cstdint>
#include <ctime>
typedef int32_t aaudio_result_t; typedef int32_t aaudio_data_callback_result_t;
enum { AAUDIO_OK = 0, AAUDIO_ERROR_DISCONNECTED = -899, AAUDIO_CALLBACK_RESULT_CONTINUE = 0, AAUDIO_DIRECTION_OUTPUT = 0, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY = 12, AAUDIO_SHARING_MODE_SHARED = 1, AAUDIO_FORMAT_PCM_I16 = 1 };
struct AAudioStream; struct AAudioStreamBuilder;
typedef aaudio_data_callback_result_t (*AAudioStream_dataCallback)(AAudioStream*, void*, void*, int32_t);
typedef void (*AAudioStream_errorCallback)(AAudioStream*, void*, aaudio_result_t);
aaudio_result_t AAudio_createStreamBuilder(AAudioStreamBuilder**); void AAudioStreamBuilder_setDirection(AAudioStreamBuilder*, int); void AAudioStreamBuilder_setPerformanceMode(AAudioStreamBuilder*, int);
void AAudioStreamBuilder_setSharingMode(AAudioStreamBuilder*, int); void AAudioStreamBuilder_setFormat(AAudioStreamBuilder*, int); void AAudioStreamBuilder_setChannelCount(AAudioStreamBuilder*, int32_t);
void AAudioStreamBuilder_setSampleRate(AAudioStreamBuilder*, int32_t); void AAudioStreamBuilder_setDataCallback(AAudioStreamBuilder*, AAudioStream_dataCallback, void*); void AAudioStreamBuilder_setErrorCallback(AAudioStreamBuilder*, AAudioStream_errorCallback, void*);
aaudio_result_t AAudioStreamBuilder_openStream(AAudioStreamBuilder*, AAudioStream**); aaudio_result_t AAudioStreamBuilder_delete(AAudioStreamBuilder*); int32_t AAudioStream_getFramesPerBurst(AAudioStream*);
aaudio_result_t AAudioStream_setBufferSizeInFrames(AAudioStream*, int32_t); aaudio_result_t AAudioStream_requestStart(AAudioStream*); aaudio_result_t AAudioStream_requestStop(AAudioStream*); aaudio_result_t AAudioStream_close(AAudioStream*);
int32_t AAudioStream_getSampleRate(AAudioStream*); int32_t AAudioStream_getBufferSizeInFrames(AAudioStream*); int32_t AAudioStream_getXRunCount(AAudioStream*);
aaudio_result_t AAudioStream_getTimestamp(AAudioStream*, clockid_t, int64_t*, int64_t*); int64_t AAudioStream_getFramesWritten(AAudioStream*); const char* AAudio_convertResultToText(aaudio_result_t);
