import Foundation
import Testing
@testable import T3Code

@Suite("Background refresh")
struct PlatformBackgroundRefreshTests {
    @Test
    @MainActor
    func usesThePermittedIdentifierAndAConservativeRetryWindow() {
        #expect(
            PlatformBackgroundRefreshCoordinator.identifier
                == "\(Bundle.main.bundleIdentifier ?? "xyz.brbc.cocoa").refresh"
        )
        #expect(PlatformBackgroundRefreshPolicy.minimumDelay == 15 * 60)
    }
}
