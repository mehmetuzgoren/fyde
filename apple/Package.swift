// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FydeKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v15)
    ],
    products: [
        .library(
            name: "FydeKit",
            targets: ["FydeKit"]
        )
    ],
    targets: [
        .target(
            name: "FydeKit",
            path: "Sources/FydeKit"
        ),
        .testTarget(
            name: "FydeKitTests",
            dependencies: ["FydeKit"],
            path: "Tests/FydeKitTests"
        )
    ]
)
