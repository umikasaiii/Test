#include <set>

#include "dslink/latency.hpp"
#include "dslink/session_machine.hpp"
#include "testing.hpp"

using namespace dslink;
using E = Event;
using S = State;

TEST(host_state_machine_happy_path) {
    std::vector<std::string> log;
    SessionMachine m([&](const std::string& l) { log.push_back(l); });
    CHECK(m.state() == S::Idle);
    CHECK(m.handle(E::StartHost));
    CHECK(m.role() == Role::Host);
    CHECK(m.state() == S::Preparing);
    CHECK(m.handle(E::Prepared));
    CHECK(m.state() == S::Hosting);
    CHECK(m.handle(E::PeerConnected));
    CHECK(m.state() == S::Connected);
    CHECK(m.handle(E::PeerConnected));  // second client
    CHECK_EQ(m.peers(), 2);
    CHECK(m.handle(E::PeerLeft));
    CHECK(m.state() == S::Connected);   // one still there
    CHECK(m.handle(E::PeerLeft));
    CHECK(m.state() == S::Hosting);     // nobody left: back to waiting
    CHECK(m.handle(E::PeerConnected));
    CHECK(m.handle(E::GameStarted));
    CHECK(m.state() == S::InGame);
    CHECK(m.handle(E::Stop));
    CHECK(m.state() == S::Idle);
    CHECK(m.role() == Role::None);
    CHECK_EQ(log.size(), std::size_t(9));   // every transition is logged exactly once
    CHECK(log[0].find("Idle -> Preparing") != std::string::npos);
}

TEST(client_download_play_happy_path) {
    SessionMachine m;
    CHECK(m.handle(E::StartJoin));
    CHECK(m.role() == Role::Client);
    CHECK(m.handle(E::Prepared));
    CHECK(m.state() == S::Discovering);
    CHECK(m.handle(E::RoomSelected));
    CHECK(m.state() == S::Joining);
    CHECK(m.handle(E::NetplayConnected));
    CHECK(m.state() == S::Connected);
    CHECK(m.handle(E::BootDS));
    CHECK(m.state() == S::BootingDS);
    CHECK(m.handle(E::DsBooted));
    CHECK(m.state() == S::WaitingForDownloadPlay);
    CHECK(m.handle(E::DownloadPlayFound));
    CHECK(m.state() == S::WaitingForDownloadPlay);
    CHECK(m.handle(E::DownloadStarted));
    CHECK(m.state() == S::Downloading);
    CHECK(m.handle(E::DownloadFinished));
    CHECK(m.state() == S::InGame);
}

TEST(client_manual_connect_skips_discovery) {
    SessionMachine m;
    CHECK(m.handle(E::StartJoin));
    CHECK(m.handle(E::ManualConnect));
    CHECK(m.state() == S::Joining);
}

TEST(illegal_transitions_are_rejected_and_logged) {
    std::vector<std::string> log;
    SessionMachine m([&](const std::string& l) { log.push_back(l); });
    CHECK(!m.handle(E::Prepared));      // Idle
    CHECK(!m.handle(E::PeerConnected));
    CHECK(!m.handle(E::DownloadStarted));
    CHECK(m.state() == S::Idle);
    CHECK_EQ(log.size(), std::size_t(3));
    CHECK(log[0].find("REJECTED") != std::string::npos);
    m.handle(E::StartHost);
    CHECK(!m.handle(E::BootDS));        // host cannot boot a download-play client
    CHECK(!m.handle(E::RoomSelected));
    CHECK(!m.handle(E::Retry));
}

TEST(disconnect_handling_and_retry) {
    SessionMachine m;
    m.handle(E::StartJoin); m.handle(E::Prepared); m.handle(E::RoomSelected);
    CHECK(!m.canRetry());                      // never connected yet
    m.handle(E::NetplayConnected);
    m.handle(E::BootDS); m.handle(E::DsBooted);
    CHECK(m.handle(E::Disconnect, "host lost"));
    CHECK(m.state() == S::Disconnected);
    CHECK_EQ(m.lastDisconnectReason(), std::string("host lost"));
    CHECK(m.canRetry());
    CHECK(m.handle(E::Retry));                 // reconnect where possible
    CHECK(m.state() == S::Joining);
    CHECK(m.handle(E::NetplayConnected));
    CHECK(m.handle(E::Disconnect, "wifi changed"));
    CHECK(m.handle(E::Reset));
    CHECK(m.state() == S::Idle);
    CHECK(!m.canRetry());
}

TEST(fail_goes_to_error_and_resets) {
    SessionMachine m;
    CHECK(!m.handle(E::Fail, "x"));            // nothing to fail in Idle
    m.handle(E::StartHost);
    CHECK(m.handle(E::Fail, "port busy"));
    CHECK(m.state() == S::Error);
    CHECK_EQ(m.lastError(), std::string("port busy"));
    CHECK(!m.handle(E::Prepared));
    CHECK(m.handle(E::Reset));
    CHECK(m.state() == S::Idle);
}

TEST(user_stop_from_any_active_state_returns_to_idle) {
    for (auto path : {std::vector<E>{E::StartHost}, {E::StartHost, E::Prepared}, {E::StartJoin, E::Prepared},
                      {E::StartJoin, E::Prepared, E::RoomSelected}}) {
        SessionMachine m;
        for (E e : path) CHECK(m.handle(e));
        CHECK(m.handle(E::Stop));
        CHECK(m.state() == S::Idle);
    }
}

TEST(host_cannot_get_client_only_disconnected_state) {
    SessionMachine m;
    m.handle(E::StartHost); m.handle(E::Prepared); m.handle(E::PeerConnected);
    CHECK(!m.handle(E::Disconnect));           // hosts use PeerLeft / Stop / Fail
    CHECK(m.state() == S::Connected);
}

TEST(transition_table_has_no_dead_end_except_idle_error_disconnected) {
    // Every state reachable must have at least one outgoing event (Stop/Fail/Reset count).
    for (Role r : {Role::Host, Role::Client}) {
        for (int s = 0; s <= int(S::Error); ++s) {
            bool any = false;
            for (int e = 0; e <= int(E::Reset); ++e)
                if (SessionMachine::next(r, S(s), E(e))) any = true;
            CHECK(any);
        }
    }
}

TEST(latency_stats_and_quality) {
    LatencyTracker t;
    CHECK(t.quality() == Quality::Unknown);
    for (double r : {2.0, 3.0, 2.5, 2.2, 3.1}) { t.onSent(); t.onReply(r); }
    LatencyStats s = t.stats();
    CHECK_EQ(s.received, 5u);
    CHECK(s.minMs == 2.0 && s.maxMs == 3.1);
    CHECK(s.avgMs > 2.5 && s.avgMs < 2.7);
    CHECK(s.jitterMs > 0 && s.jitterMs < 1);
    CHECK_EQ(s.lossPercent, 0.0);
    CHECK(t.quality() == Quality::Excellent);

    LatencyTracker slow;
    for (double r : {40.0, 90.0, 20.0, 120.0}) { slow.onSent(); slow.onReply(r); }
    CHECK(slow.quality() == Quality::Insufficient);

    LatencyTracker lossy;
    for (int i = 0; i < 10; ++i) { lossy.onSent(); if (i % 2) lossy.onReply(2.0); }
    CHECK_EQ(lossy.stats().lossPercent, 50.0);
    CHECK(lossy.quality() == Quality::Insufficient);

    LatencyTracker dead;
    dead.onSent(); dead.onSent();
    CHECK(dead.quality() == Quality::Insufficient);
    CHECK_EQ(qualityLabel(Quality::Excellent), std::string("Ottima"));
}
