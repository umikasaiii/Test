cmake_minimum_required(VERSION 3.16)
project(dslink_native VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

option(DSLINK_BUILD_TESTS "Build the native unit tests" ON)

set(DSLINK_SOURCES
    src/sha256.cpp src/kv.cpp src/identity.cpp src/advert.cpp src/netaddr.cpp src/firmware.cpp
    src/latency.cpp src/session_machine.cpp src/control.cpp src/launch.cpp src/diagnostics.cpp src/rom.cpp src/c_api.cpp)

add_library(dslink STATIC ${DSLINK_SOURCES})
target_include_directories(dslink PUBLIC include)
if(MSVC)
  target_compile_options(dslink PRIVATE /W4)
else()
  target_compile_options(dslink PRIVATE -Wall -Wextra -Wpedantic)
endif()
find_package(Threads REQUIRED)
target_link_libraries(dslink PUBLIC Threads::Threads)

add_executable(dslink_cfgtool tools/cfgtool.cpp)
target_link_libraries(dslink_cfgtool PRIVATE dslink)

if(DSLINK_BUILD_TESTS)
  enable_testing()
  file(GLOB DSLINK_TEST_SOURCES tests/test_*.cpp)
  add_executable(dslink_tests tests/main.cpp ${DSLINK_TEST_SOURCES})
  target_link_libraries(dslink_tests PRIVATE dslink)
  add_test(NAME dslink_tests COMMAND dslink_tests)
endif()
