#pragma once
#include <cstdarg>
enum { ANDROID_LOG_INFO = 4, ANDROID_LOG_ERROR = 6 };
inline int __android_log_print(int, const char*, const char*, ...) { return 0; }
