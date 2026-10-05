# DSLink native module for the Android build. Included from RetroArch's phoenix-common/jni/Android.mk by
# patches/retroarch/0002-dslink-android-app.patch.
LOCAL_PATH := $(call my-dir)
DSLINK_ROOT := $(LOCAL_PATH)/../../dslink

include $(CLEAR_VARS)
LOCAL_MODULE := dslink_jni
LOCAL_SRC_FILES := dslink_jni.cpp \
    $(DSLINK_ROOT)/src/sha256.cpp $(DSLINK_ROOT)/src/kv.cpp $(DSLINK_ROOT)/src/identity.cpp \
    $(DSLINK_ROOT)/src/advert.cpp $(DSLINK_ROOT)/src/netaddr.cpp $(DSLINK_ROOT)/src/firmware.cpp \
    $(DSLINK_ROOT)/src/latency.cpp $(DSLINK_ROOT)/src/session_machine.cpp $(DSLINK_ROOT)/src/control.cpp \
    $(DSLINK_ROOT)/src/launch.cpp $(DSLINK_ROOT)/src/diagnostics.cpp $(DSLINK_ROOT)/src/rom.cpp \
    $(DSLINK_ROOT)/src/c_api.cpp
LOCAL_C_INCLUDES := $(DSLINK_ROOT)/include
LOCAL_CPPFLAGS := -std=c++17 -fexceptions -frtti -Wall
LOCAL_LDLIBS := -llog
include $(BUILD_SHARED_LIBRARY)
