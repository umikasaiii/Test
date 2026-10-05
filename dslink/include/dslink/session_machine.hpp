// DSLink - multiplayer session state machine (host and client). Every transition is logged.
#pragma once
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace dslink {

enum class Role { None, Host, Client };

enum class State {
    Idle, Preparing, Discovering, Hosting, Joining, Connected,
    BootingDS, WaitingForDownloadPlay, Downloading, InGame, Disconnected, Error,
};

enum class Event {
    StartHost,         // Idle -> Preparing (host)
    StartJoin,         // Idle -> Preparing (client)
    Prepared,          // identity / firmware / network ready
    ManualConnect,     // client typed IP+port
    RoomSelected,      // client picked a discovered room
    PeerConnected,     // host: a client completed the DSLink handshake + Netplay connect
    PeerLeft,          // host: one client left; data = remaining peers (0 -> back to Hosting)
    NetplayConnected,  // client: Netplay link to the host is up
    BootDS,            // client: start the DS with no cartridge
    DsBooted,          // client: DS firmware menu reached
    DownloadPlayFound, // client: host's software is listed in Download Play (kept for logging)
    DownloadStarted,
    DownloadFinished,
    GameStarted,
    Disconnect,        // connection lost (host gone, network changed, timeout)
    Stop,              // user left the session on purpose
    Fail,              // unrecoverable error; message in the data string
    Retry,             // client: try the same host again after a disconnect
    Reset,             // Disconnected / Error -> Idle
};

const char* stateName(State s);
const char* eventName(Event e);
const char* roleName(Role r);

struct Transition {
    State from, to;
    Event event;
    Role role;
};

class SessionMachine {
public:
    using Logger = std::function<void(const std::string&)>;
    explicit SessionMachine(Logger log = nullptr) : log_(std::move(log)) {}

    // Returns true when the event caused (or legally self-looped) a transition; false = rejected + logged.
    bool handle(Event e, const std::string& info = {}, int remainingPeers = -1);

    State state() const { return state_; }
    Role role() const { return role_; }
    int peers() const { return peers_; }
    bool canRetry() const { return role_ == Role::Client && state_ == State::Disconnected && hadConnection_; }
    const std::string& lastError() const { return lastError_; }
    const std::string& lastDisconnectReason() const { return lastDisconnect_; }
    const std::vector<Transition>& history() const { return history_; }

    // Pure lookup, also used by tests to dump the whole table.
    static std::optional<State> next(Role role, State from, Event e);

private:
    void log(const std::string& s) { if (log_) log_(s); }
    Logger log_;
    State state_ = State::Idle;
    Role role_ = Role::None;
    int peers_ = 0;
    bool hadConnection_ = false;
    std::string lastError_, lastDisconnect_;
    std::vector<Transition> history_;
};

}  // namespace dslink
