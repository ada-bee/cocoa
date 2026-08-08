import Foundation

enum T3SharedContainer {
    #if DEBUG
    static let appGroupID = "group.xyz.brbc.cocoa.dev"
    static let urlScheme = "cocoa-dev"
    #else
    static let appGroupID = "group.xyz.brbc.cocoa"
    static let urlScheme = "cocoa"
    #endif

    static var rootURL: URL? {
        FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupID
        )
    }
}
