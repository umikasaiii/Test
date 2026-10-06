cmake_minimum_required(VERSION 3.18)
project(dslink_android_native CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(REPO "${CMAKE_CURRENT_SOURCE_DIR}/../..")
set(RT_SRC "${REPO}/runtime/src")

option(DSLINK_HOST_TEST "Desktop build of the platform-neutral front end + its unit test (no Android API)" OFF)

add_library(dsfe STATIC front_end.cpp ${RT_SRC}/shm_sink.cpp)
target_include_directories(dsfe PUBLIC ${CMAKE_CURRENT_SOURCE_DIR} ${RT_SRC})

if(DSLINK_HOST_TEST)
  add_executable(fe_test tests/fe_test.cpp)
  target_link_libraries(fe_test PRIVATE dsfe)
  return()
endif()

# ---- Android: everything the APK carries as native code, built with ONE toolchain call (scripts/build_android_native.sh)
#  * dslink-runtime    the existing C++ Runtime (no FFmpeg: the app reads raw frames from shared memory)   -> libdslink_runtime.so (executable)
#  * dslink_cfgtool / dslink_romcheck  the existing DSLink C++ tools (identity, options, ROM check)         -> libdslink_cfgtool.so / libdslink_romcheck.so
#  * dslink_jni        JNI: GL renderer, AAudio output, input, metrics, private-file validation
set(DSLINK_BUILD_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory(${REPO}/dslink dslink_build)
set(DSLINK_WITH_FFMPEG OFF CACHE BOOL "" FORCE)
add_subdirectory(${REPO}/runtime runtime_build)

add_library(dslink_jni SHARED jni_bridge.cpp renderer.cpp audio_out.cpp)
target_link_libraries(dslink_jni PRIVATE dsfe dslink android log EGL GLESv2 aaudio)
