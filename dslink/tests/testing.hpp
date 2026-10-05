// Minimal self-registering test framework (no external dependency, builds on every CI runner).
#pragma once
#include <functional>
#include <iostream>
#include <string>
#include <vector>

struct TestCase { const char* name; std::function<void()> fn; };
inline std::vector<TestCase>& registry() { static std::vector<TestCase> r; return r; }
struct Registrar { Registrar(const char* n, std::function<void()> f) { registry().push_back({n, std::move(f)}); } };
inline int& failures() { static int f = 0; return f; }

#define TEST(name) \
    static void test_##name(); \
    static Registrar reg_##name(#name, test_##name); \
    static void test_##name()

#define CHECK(cond) \
    do { if (!(cond)) { ++failures(); std::cerr << "  CHECK failed: " #cond " at " << __FILE__ << ":" << __LINE__ << "\n"; } } while (0)
#define CHECK_EQ(a, b) \
    do { auto _a = (a); auto _b = (b); if (!(_a == _b)) { ++failures(); std::cerr << "  CHECK_EQ failed: " #a " == " #b " at " << __FILE__ << ":" << __LINE__ << "\n"; } } while (0)
