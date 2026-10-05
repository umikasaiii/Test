cmake_minimum_required(VERSION 3.16)
project(dslink_runtime CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(PkgConfig REQUIRED)
pkg_check_modules(FFMPEG REQUIRED IMPORTED_TARGET libavcodec libavutil libswscale libswresample)
find_package(Threads REQUIRED)

# libretro.h comes from the pinned RetroArch submodule (libretro-common, MIT) - not copied into the repo.
set(LIBRETRO_INCLUDE "${CMAKE_SOURCE_DIR}/../upstream/retroarch/libretro-common/include" CACHE PATH "directory containing libretro.h")

add_executable(dslink-runtime src/main.cpp src/libretro_host.cpp src/mp_bridge.cpp src/av_pipeline.cpp src/link.cpp)
target_include_directories(dslink-runtime PRIVATE src ${LIBRETRO_INCLUDE})
target_compile_options(dslink-runtime PRIVATE -Wall -Wextra)
target_link_libraries(dslink-runtime PRIVATE PkgConfig::FFMPEG Threads::Threads ${CMAKE_DL_LIBS})

# Test core for the multiplayer bridge (NETPACKET interface only).
add_library(npt_testcore MODULE tests/netpacket_testcore.cpp)
target_include_directories(npt_testcore PRIVATE ${LIBRETRO_INCLUDE})
set_target_properties(npt_testcore PROPERTIES PREFIX "" OUTPUT_NAME "dslink_npt_libretro")
