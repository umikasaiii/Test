# DSLink Runtime for WebAssembly: libretro host + the melonDS DS core (built from the pinned upstream by scripts/build_wasm.sh with the patch in wasm/patches).
# Not part of the desktop/Android builds. Configure with emcmake.
cmake_minimum_required(VERSION 3.19)
project(dslink_wasm CXX C)
set(CMAKE_CXX_STANDARD 17)

set(CORE_BUILD "" CACHE PATH "build directory of the melonDS DS core (static libraries)")
set(LIBRETRO_INCLUDE "" CACHE PATH "libretro-common/include")
set(DEPS_BUILD "" CACHE PATH "FETCHCONTENT_BASE_DIR of the core build (melonDS, fmt, glm, zlib... are built below it)")
if (NOT CORE_BUILD OR NOT LIBRETRO_INCLUDE)
    message(FATAL_ERROR "set CORE_BUILD and LIBRETRO_INCLUDE")
endif ()

file(GLOB_RECURSE CORE_LIBS "${CORE_BUILD}/*.a" "${DEPS_BUILD}/*-build/*.a")
# the core archive is named .so by the upstream build (static archive); the others are plain .a
list(FILTER CORE_LIBS EXCLUDE REGEX "CMakeFiles")

add_executable(dslink_wasm dslink_wasm.cpp webrtc_link.cpp ../runtime/src/libretro_host.cpp ../runtime/src/mp_bridge.cpp ../runtime/src/dlplay_diag.cpp)
target_include_directories(dslink_wasm PRIVATE ../runtime/src ${LIBRETRO_INCLUDE})
target_compile_definitions(dslink_wasm PRIVATE DSLINK_WASM=1)
target_compile_options(dslink_wasm PRIVATE -fwasm-exceptions -O3)
target_link_libraries(dslink_wasm PRIVATE -Wl,--start-group "${CORE_BUILD}/src/libretro/melondsds_libretro.so" ${CORE_LIBS} -Wl,--end-group)
target_link_options(dslink_wasm PRIVATE
    -fwasm-exceptions -O3
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createDslink
    -sENVIRONMENT=web,worker
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 -sMAXIMUM_MEMORY=1073741824
    -sSTACK_SIZE=2097152 -sEXPORTED_FUNCTIONS=_malloc,_free
    -sFILESYSTEM=1 -sFORCE_FILESYSTEM=1
    -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,HEAP16,HEAPF32,UTF8ToString,stringToUTF8,lengthBytesUTF8,wasmMemory
    -sASSERTIONS=0 -sNO_EXIT_RUNTIME=1)
set_target_properties(dslink_wasm PROPERTIES SUFFIX ".js")
