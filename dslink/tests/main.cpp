#include "testing.hpp"

int main(int argc, char** argv) {
    std::string filter = argc > 1 ? argv[1] : "";
    int ran = 0, bad = 0;
    for (auto& t : registry()) {
        if (!filter.empty() && std::string(t.name).find(filter) == std::string::npos) continue;
        int before = failures();
        t.fn();
        ++ran;
        bool ok = failures() == before;
        if (!ok) ++bad;
        std::cout << (ok ? "[ PASS ] " : "[ FAIL ] ") << t.name << "\n";
    }
    std::cout << "\n" << (ran - bad) << "/" << ran << " tests passed\n";
    return bad == 0 ? 0 : 1;
}
