#pragma once
#include <jni.h>
#include <android/native_window.h>
inline ANativeWindow* ANativeWindow_fromSurface(JNIEnv*, jobject) { return nullptr; }
