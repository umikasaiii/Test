// Developer/cloud tool: validates a .nds header and prints kv (status, title, game_code, size, sha256).
#include <iostream>

#include "dslink/rom.hpp"

int main(int argc, char** argv) {
    if (argc < 2) return 2;
    dslink::RomInfo r = dslink::inspectRomFile(argv[1]);
    std::cout << "status=" << dslink::romStatusCode(r.status) << "\nmessage=" << dslink::romStatusMessage(r.status)
              << "\ntitle=" << r.title << "\ngame_code=" << r.gameCode << "\nunit_code=" << int(r.unitCode)
              << "\nsize=" << r.fileSize << "\nsha256=" << r.sha256 << "\n";
    return r.status == dslink::RomStatus::Ok ? 0 : 1;
}
