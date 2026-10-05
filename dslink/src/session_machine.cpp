#include "dslink/session_machine.hpp"

namespace dslink {

const char* stateName(State s) {
    switch (s) {
        case State::Idle: return "Idle";
        case State::Preparing: return "Preparing";
        case State::Discovering: return "Discovering";
        case State::Hosting: return "Hosting";
        case State::Joining: return "Joining";
        case State::Connected: return "Connected";
        case State::BootingDS: return "BootingDS";
        case State::WaitingForDownloadPlay: return "WaitingForDownloadPlay";
        case State::Downloading: return "Downloading";
        case State::InGame: return "InGame";
        case State::Disconnected: return "Disconnected";
        case State::Error: return "Error";
    }
    return "?";
}

const char* eventName(Event e) {
    switch (e) {
        case Event::StartHost: return "StartHost";
        case Event::StartJoin: return "StartJoin";
        case Event::Prepared: return "Prepared";
        case Event::ManualConnect: return "ManualConnect";
        case Event::RoomSelected: return "RoomSelected";
        case Event::PeerConnected: return "PeerConnected";
        case Event::PeerLeft: return "PeerLeft";
        case Event::NetplayConnected: return "NetplayConnected";
        case Event::BootDS: return "BootDS";
        case Event::DsBooted: return "DsBooted";
        case Event::DownloadPlayFound: return "DownloadPlayFound";
        case Event::DownloadStarted: return "DownloadStarted";
        case Event::DownloadFinished: return "DownloadFinished";
        case Event::GameStarted: return "GameStarted";
        case Event::Disconnect: return "Disconnect";
        case Event::Stop: return "Stop";
        case Event::Fail: return "Fail";
        case Event::Retry: return "Retry";
        case Event::Reset: return "Reset";
    }
    return "?";
}

const char* roleName(Role r) {
    switch (r) {
        case Role::None: return "none";
        case Role::Host: return "host";
        case Role::Client: return "client";
    }
    return "?";
}

std::optional<State> SessionMachine::next(Role role, State from, Event e) {
    using S = State;
    using E = Event;
    // Events valid in any state.
    if (e == E::Reset) return (from == S::Disconnected || from == S::Error) ? std::optional<S>(S::Idle) : std::nullopt;
    if (e == E::Stop) return from == S::Idle ? std::nullopt : std::optional<S>(S::Idle);
    if (e == E::Fail) return (from == S::Idle || from == S::Error) ? std::nullopt : std::optional<S>(S::Error);
    if (e == E::Disconnect) {
        switch (from) {
            case S::Joining: case S::Connected: case S::BootingDS: case S::WaitingForDownloadPlay:
            case S::Downloading: case S::InGame:
                return role == Role::Client ? std::optional<S>(S::Disconnected) : std::nullopt;
            case S::Hosting: case S::Preparing: case S::Discovering:
                return std::nullopt;
            default: return std::nullopt;
        }
    }
    switch (from) {
        case S::Idle:
            if (e == E::StartHost || e == E::StartJoin) return S::Preparing;
            break;
        case S::Preparing:
            if (e == E::Prepared) return role == Role::Host ? S::Hosting : S::Discovering;
            if (e == E::ManualConnect && role == Role::Client) return S::Joining;
            break;
        case S::Discovering:
            if (e == E::RoomSelected || e == E::ManualConnect) return S::Joining;
            break;
        case S::Hosting:
            if (e == E::PeerConnected) return S::Connected;
            if (e == E::GameStarted && role == Role::Host) return S::InGame;
            break;
        case S::Joining:
            if (e == E::NetplayConnected) return S::Connected;
            break;
        case S::Connected:
            if (role == Role::Host) {
                if (e == E::PeerConnected) return S::Connected;
                if (e == E::PeerLeft) return S::Hosting;  // caller decides via remainingPeers (see handle())
                if (e == E::GameStarted) return S::InGame;
            } else {
                if (e == E::BootDS) return S::BootingDS;
                if (e == E::GameStarted) return S::InGame;  // MultiRom mode
            }
            break;
        case S::BootingDS:
            if (e == E::DsBooted) return S::WaitingForDownloadPlay;
            break;
        case S::WaitingForDownloadPlay:
            if (e == E::DownloadPlayFound) return S::WaitingForDownloadPlay;
            if (e == E::DownloadStarted) return S::Downloading;
            if (e == E::GameStarted) return S::InGame;
            break;
        case S::Downloading:
            if (e == E::DownloadFinished || e == E::GameStarted) return S::InGame;
            break;
        case S::InGame:
            if (role == Role::Host && (e == E::PeerConnected || e == E::PeerLeft)) return S::InGame;
            break;
        case S::Disconnected:
            if (e == E::Retry && role == Role::Client) return S::Joining;
            break;
        case S::Error:
            break;
    }
    return std::nullopt;
}

bool SessionMachine::handle(Event e, const std::string& info, int remaining) {
    Role newRole = role_;
    if (state_ == State::Idle) {
        if (e == Event::StartHost) newRole = Role::Host;
        else if (e == Event::StartJoin) newRole = Role::Client;
    }
    auto to = next(newRole, state_, e);
    if (!to) {
        log(std::string("[session] REJECTED ") + eventName(e) + " in state " + stateName(state_) + " (" +
            roleName(role_) + ")");
        return false;
    }
    State dest = *to;
    // Host peer accounting: PeerLeft only drops back to Hosting when nobody is left.
    if (newRole == Role::Host) {
        if (e == Event::PeerConnected) peers_ = remaining >= 0 ? remaining : peers_ + 1;
        if (e == Event::PeerLeft) {
            peers_ = remaining >= 0 ? remaining : (peers_ > 0 ? peers_ - 1 : 0);
            if (state_ == State::Connected) dest = peers_ > 0 ? State::Connected : State::Hosting;
        }
    }
    if (e == Event::Fail) lastError_ = info;
    if (e == Event::Disconnect) lastDisconnect_ = info;
    if (dest == State::Connected && newRole == Role::Client) hadConnection_ = true;
    if (e == Event::Reset || e == Event::Stop) {
        newRole = Role::None;
        peers_ = 0;
        hadConnection_ = false;
    }
    history_.push_back({state_, dest, e, newRole});
    if (history_.size() > 200) history_.erase(history_.begin());
    log(std::string("[session] ") + stateName(state_) + " -> " + stateName(dest) + " on " + eventName(e) +
        (info.empty() ? "" : " (" + info + ")"));
    state_ = dest;
    role_ = newRole;
    return true;
}

}  // namespace dslink
