# PlaySphere PS1 Runtime for WebAssembly: the libretro host (shared with the Nintendo DS runtime) + the PCSX-ReARMed core, built by scripts/build_ps1_wasm.sh.
# Not part of the desktop/Android builds. Configure with emcmake.
cmake_minimum_required(VERSION 3.19)
project(playsphere_ps1 CXX C)
set(CMAKE_CXX_STANDARD 17)

set(CORE_ARCHIVE "" CACHE FILEPATH "pcsx_rearmed_libretro_emscripten.bc (a static archive)")
set(CORE_SRC "" CACHE PATH "PCSX-ReARMed source tree (for the libchdr headers)")
set(LIBRETRO_INCLUDE "" CACHE PATH "libretro-common/include")
if (NOT CORE_ARCHIVE OR NOT CORE_SRC OR NOT LIBRETRO_INCLUDE)
    message(FATAL_ERROR "set CORE_ARCHIVE, CORE_SRC and LIBRETRO_INCLUDE")
endif ()

add_executable(playsphere_ps1 ps1_wasm.cpp ../../runtime/src/libretro_host.cpp)
target_include_directories(playsphere_ps1 PRIVATE ../../runtime/src ${LIBRETRO_INCLUDE} ${CORE_SRC}/deps/libchdr/include)
target_compile_definitions(playsphere_ps1 PRIVATE DSLINK_WASM=1)
target_compile_options(playsphere_ps1 PRIVATE -O3 -msimd128 -fwasm-exceptions)
target_link_libraries(playsphere_ps1 PRIVATE -Wl,--whole-archive "${CORE_ARCHIVE}" -Wl,--no-whole-archive)
# WORKERFS: the user's disc images are mounted from File objects and read on demand (a 700 MB image is never copied into memory)
target_link_options(playsphere_ps1 PRIVATE
    -fwasm-exceptions -O3 -msimd128 -lworkerfs.js
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPlaySpherePs1
    -sENVIRONMENT=web,worker
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=536870912
    -sSTACK_SIZE=4194304 -sEXPORTED_FUNCTIONS=_malloc,_free
    -sFILESYSTEM=1 -sFORCE_FILESYSTEM=1
    -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,HEAP16,HEAPF32,UTF8ToString,stringToUTF8,lengthBytesUTF8,wasmMemory
    -sASSERTIONS=0 -sNO_EXIT_RUNTIME=1)
set_target_properties(playsphere_ps1 PROPERTIES SUFFIX ".js")
