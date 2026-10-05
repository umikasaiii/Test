import SwiftUI

@main
struct DSLinkApp: App {
    @StateObject private var store = Store()

    init() {
        Native.log("[app] DSLink \(AppInfo.appVersion) on iOS \(UIDevice.current.systemVersion)")
    }

    var body: some Scene {
        WindowGroup {
            NavigationStack { HomeView() }
                .environmentObject(store)
                .preferredColorScheme(.dark)
                .tint(Color(red: 0.31, green: 0.55, blue: 1.0))
        }
    }
}
