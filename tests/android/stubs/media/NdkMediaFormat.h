// Syntax-check stub of the NDK's <media/NdkMediaFormat.h> (CI compiles the Android-only sources against it on the host; the real header comes from the NDK).
#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef int32_t media_status_t;
enum { AMEDIA_OK = 0 };
struct AMediaFormat;
typedef struct AMediaFormat AMediaFormat;
AMediaFormat* AMediaFormat_new(void);
media_status_t AMediaFormat_delete(AMediaFormat*);
void AMediaFormat_setInt32(AMediaFormat*, const char* name, int32_t value);
void AMediaFormat_setString(AMediaFormat*, const char* name, const char* value);
bool AMediaFormat_getInt32(AMediaFormat*, const char* name, int32_t* out);
bool AMediaFormat_getBuffer(AMediaFormat*, const char* name, void** data, size_t* size);
#ifdef __cplusplus
}
#endif
