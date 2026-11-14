import SwiftUI
import FydeKit

@main
struct FydeApp: App {
    @State private var store = FydeStore()

    var body: some Scene {
        WindowGroup {
            FydeRootView(store: store)
                #if os(macOS)
                .frame(minWidth: 920, minHeight: 640)
                #endif
        }
    }
}
