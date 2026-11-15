import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

// MARK: - Theme Tokens ("Paper": ivory ground, white cards, one terracotta accent, Georgia titles)

public enum FydeTheme {
    public static let paper = Color.fydeDynamic(light: 0xFAF9F6, dark: 0x151412)
    public static let surface = Color.fydeDynamic(light: 0xFFFFFF, dark: 0x1F1E1A)
    public static let sunken = Color.fydeDynamic(light: 0xF3F1EC, dark: 0x2A2924)
    public static let ink = Color.fydeDynamic(light: 0x252B20, dark: 0xF2F0EA)
    public static let inkSecondary = Color.fydeDynamic(light: 0x5C6058, dark: 0xB7B4AB)
    public static let muted = Color.fydeDynamic(light: 0x8E9089, dark: 0x8A8880)
    public static let line = Color.fydeDynamic(light: 0xE8E5DE, dark: 0x34322C)

    public static let accent = Color.fydeDynamic(light: 0xC8432A, dark: 0xE3633F)
    public static let accentSoft = Color.fydeDynamic(light: 0xFBEDE8, dark: 0x3A241D)

    public static let success = Color.fydeDynamic(light: 0x2E7A4C, dark: 0x62BE86)
    public static let successSoft = Color.fydeDynamic(light: 0xE8F4EC, dark: 0x1C3325)
    public static let warning = Color.fydeDynamic(light: 0xA86A12, dark: 0xE4AA4E)
    public static let warningSoft = Color.fydeDynamic(light: 0xFBF1E1, dark: 0x3A2D17)
    public static let live = Color.fydeDynamic(light: 0x2F6BE6, dark: 0x6B98F2)
    public static let liveSoft = Color.fydeDynamic(light: 0xEAF0FD, dark: 0x1C2740)

    /// Georgia is reserved for titles; body copy stays in the system sans.
    public static func serif(_ size: CGFloat, bold: Bool = true, relativeTo style: Font.TextStyle = .title2) -> Font {
        .custom(bold ? "Georgia-Bold" : "Georgia", size: size, relativeTo: style)
    }
}

extension Color {
    static func fydeDynamic(light: UInt32, dark: UInt32) -> Color {
        #if canImport(UIKit)
        return Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(fydeHex: dark) : UIColor(fydeHex: light)
        })
        #elseif canImport(AppKit)
        return Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(fydeHex: dark) : NSColor(fydeHex: light)
        })
        #else
        return Color(fydeHex: light)
        #endif
    }

    init(fydeHex hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0
        )
    }

    /// Parses "#RRGGBB" strings (e.g. `UserProfile.avatarColor`).
    init?(fydeHexString string: String) {
        let cleaned = string.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "#", with: "")
        guard cleaned.count == 6, let value = UInt32(cleaned, radix: 16) else { return nil }
        self.init(fydeHex: value)
    }
}

#if canImport(UIKit)
private extension UIColor {
    convenience init(fydeHex hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255.0,
            green: CGFloat((hex >> 8) & 0xFF) / 255.0,
            blue: CGFloat(hex & 0xFF) / 255.0,
            alpha: 1
        )
    }
}
#elseif canImport(AppKit)
private extension NSColor {
    convenience init(fydeHex hex: UInt32) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255.0,
            green: CGFloat((hex >> 8) & 0xFF) / 255.0,
            blue: CGFloat(hex & 0xFF) / 255.0,
            alpha: 1
        )
    }
}
#endif

// MARK: - Tones

enum FydeTone {
    case neutral, accent, success, warning, live

    var foreground: Color {
        switch self {
        case .neutral: return FydeTheme.inkSecondary
        case .accent: return FydeTheme.accent
        case .success: return FydeTheme.success
        case .warning: return FydeTheme.warning
        case .live: return FydeTheme.live
        }
    }

    var background: Color {
        switch self {
        case .neutral: return FydeTheme.sunken
        case .accent: return FydeTheme.accentSoft
        case .success: return FydeTheme.successSoft
        case .warning: return FydeTheme.warningSoft
        case .live: return FydeTheme.liveSoft
        }
    }
}

// MARK: - Card Surface

struct FydeCardModifier: ViewModifier {
    var padding: CGFloat
    var radius: CGFloat
    var stroke: Color

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(FydeTheme.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(stroke, lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.035), radius: 10, x: 0, y: 3)
    }
}

extension View {
    func fydeCard(padding: CGFloat = 16, radius: CGFloat = 20, stroke: Color = FydeTheme.line) -> some View {
        modifier(FydeCardModifier(padding: padding, radius: radius, stroke: stroke))
    }
}

// MARK: - Brand Mark (rotated terracotta "f" tile)

public struct FydeMark: View {
    var size: CGFloat

    public init(size: CGFloat = 32) {
        self.size = size
    }

    public var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
                .fill(FydeTheme.accent)
            Text("f")
                .font(.custom("Georgia-Bold", size: size * 0.68))
                .foregroundStyle(.white)
                .offset(x: -size * 0.01, y: -size * 0.03)
        }
        .frame(width: size, height: size)
        .rotationEffect(.degrees(-8))
        .accessibilityHidden(true)
    }
}

// MARK: - Avatar

struct FydeAvatar: View {
    let name: String
    var hex: String?
    var size: CGFloat = 32

    private static let palette: [UInt32] = [0xC8432A, 0x2E7A4C, 0x3F5FA8, 0x8A5A9E, 0xA86A12, 0x2C7C83]

    private var fill: Color {
        if let hex, let c = Color(fydeHexString: hex) { return c }
        let seed = name.unicodeScalars.reduce(0) { $0 + Int($1.value) }
        return Color(fydeHex: Self.palette[seed % Self.palette.count])
    }

    var body: some View {
        Circle()
            .fill(fill)
            .frame(width: size, height: size)
            .overlay(
                Text(String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
                    .font(.system(size: size * 0.42, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
            )
            .accessibilityLabel(name)
    }
}

// MARK: - Chips & Tiles

struct FydeChip: View {
    let text: String
    var icon: String?
    var tone: FydeTone = .neutral

    var body: some View {
        HStack(spacing: 4) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .bold))
            }
            Text(text)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(tone.background, in: Capsule())
        .foregroundStyle(tone.foreground)
    }
}

struct FydeIconTile: View {
    let systemName: String
    var tone: FydeTone = .accent
    var size: CGFloat = 36

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
            .fill(tone.background)
            .frame(width: size, height: size)
            .overlay(
                Image(systemName: systemName)
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(tone.foreground)
            )
    }
}

/// Small rounded pill used in header strips (Vexo status, people & access).
struct FydeStatusPill<Leading: View>: View {
    let title: String
    var detail: String?
    var tone: FydeTone = .neutral
    @ViewBuilder var leading: () -> Leading

    var body: some View {
        HStack(spacing: 6) {
            leading()
            Text(title)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(tone == .neutral ? FydeTheme.ink : tone.foreground)
            if let detail {
                Text(detail)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(FydeTheme.muted)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(tone == .neutral ? FydeTheme.surface : tone.background, in: Capsule())
        .overlay(Capsule().strokeBorder(tone == .neutral ? FydeTheme.line : tone.foreground.opacity(0.25), lineWidth: 1))
    }
}

// MARK: - Thumbnail

struct FydeThumbnail: View {
    let mediaType: MediaType
    let url: URL?
    var size: CGFloat = 56
    var radius: CGFloat = 12

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(placeholderFill)

            if mediaType == .photo, let url {
                AsyncImage(url: url) { phase in
                    if case .success(let image) = phase {
                        image
                            .resizable()
                            .scaledToFill()
                    } else {
                        placeholderIcon
                    }
                }
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            } else {
                placeholderIcon
            }

            if mediaType == .video {
                Image(systemName: "play.fill")
                    .font(.system(size: size * 0.18, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(size * 0.08)
                    .background(Color.black.opacity(0.35), in: Circle())
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(size * 0.07)
            }
        }
        .frame(width: size, height: size)
    }

    private var placeholderFill: Color {
        switch mediaType {
        case .video: return FydeTheme.ink.opacity(0.82)
        case .document: return FydeTheme.accentSoft
        default: return FydeTheme.sunken
        }
    }

    private var placeholderIcon: some View {
        Image(systemName: iconName)
            .font(.system(size: size * 0.34, weight: .medium))
            .foregroundStyle(mediaType == .video ? Color.white.opacity(0.9) : (mediaType == .document ? FydeTheme.accent : FydeTheme.muted))
    }

    private var iconName: String {
        switch mediaType {
        case .photo: return "photo"
        case .video: return "video"
        case .document: return "doc.text"
        case .audio: return "waveform"
        case .folder: return "folder"
        }
    }
}

// MARK: - Buttons

struct FydePrimaryButtonStyle: ButtonStyle {
    var fullWidth = true
    var tint: Color = FydeTheme.accent
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: 44)
            .background(isEnabled ? tint : FydeTheme.muted.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .opacity(configuration.isPressed ? 0.82 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

struct FydeSecondaryButtonStyle: ButtonStyle {
    var fullWidth = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .foregroundStyle(FydeTheme.ink)
            .padding(.horizontal, 16)
            .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: 44)
            .background(FydeTheme.sunken, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .opacity(configuration.isPressed ? 0.75 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

/// 40pt white circle with hairline border — header actions.
struct FydeCircleIcon: View {
    let systemName: String
    var size: CGFloat = 40

    var body: some View {
        Circle()
            .fill(FydeTheme.surface)
            .overlay(Circle().strokeBorder(FydeTheme.line, lineWidth: 1))
            .frame(width: size, height: size)
            .overlay(
                Image(systemName: systemName)
                    .font(.system(size: size * 0.4, weight: .semibold))
                    .foregroundStyle(FydeTheme.ink)
            )
            .contentShape(Circle())
    }
}

// MARK: - Segmented Control

struct FydeSegmented<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(value: Value, label: String)]
    @Namespace private var ns

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                let isOn = option.value == selection
                Button {
                    withAnimation(.spring(duration: 0.28)) { selection = option.value }
                } label: {
                    Text(option.label)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(isOn ? FydeTheme.ink : FydeTheme.inkSecondary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, minHeight: 34)
                        .background {
                            if isOn {
                                Capsule()
                                    .fill(FydeTheme.surface)
                                    .shadow(color: Color.black.opacity(0.08), radius: 3, y: 1)
                                    .matchedGeometryEffect(id: "seg", in: ns)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(FydeTheme.sunken, in: Capsule())
    }
}

// MARK: - Top Bar (leading • centered title • trailing)

struct FydeTopBar<Leading: View, Center: View, Trailing: View>: View {
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var center: () -> Center
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        ZStack {
            center()
                .frame(maxWidth: .infinity)
            HStack {
                leading()
                Spacer(minLength: 0)
                trailing()
            }
        }
        .frame(height: 52)
        .padding(.horizontal, 16)
    }
}

struct FydeTitle: View {
    let text: String

    var body: some View {
        Text(text)
            .font(FydeTheme.serif(22, relativeTo: .title3))
            .foregroundStyle(FydeTheme.ink)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Avatar button that opens the account / peer switcher / settings menu.
struct FydeAccountMenu: View {
    @Bindable var store: FydeStore
    var onOpenSettings: () -> Void

    var body: some View {
        Menu {
            Section("Signed in as \(store.currentUser.displayName)") {
                Label("@\(store.currentUser.handle)", systemImage: "at")
            }
            Button(action: onOpenSettings) {
                Label("Settings", systemImage: "gearshape")
            }
            Button(role: .destructive) {
                Task { await store.signOut() }
            } label: {
                Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
            }
        } label: {
            FydeAvatar(name: store.currentUser.displayName, hex: store.currentUser.avatarColor, size: 38)
                .overlay(alignment: .bottomTrailing) {
                    Circle()
                        .fill(store.isRelayConnected ? FydeTheme.success : FydeTheme.warning)
                        .frame(width: 11, height: 11)
                        .overlay(Circle().strokeBorder(FydeTheme.paper, lineWidth: 2))
                        .offset(x: 1, y: 1)
                }
                .padding(1)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Account: \(store.currentUser.displayName), \(store.isRelayConnected ? "online" : "offline")")
    }
}

// MARK: - Section Header & Empty State

struct FydeSectionHeader: View {
    let title: String
    var count: Int?
    var tone: FydeTone = .neutral

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title)
                .font(FydeTheme.serif(19, relativeTo: .headline))
                .foregroundStyle(FydeTheme.ink)
            if let count {
                FydeChip(text: "\(count)", tone: tone)
            }
            Spacer()
        }
        .padding(.horizontal, 4)
        .accessibilityAddTraits(.isHeader)
    }
}

struct FydeEmptyState<Footer: View>: View {
    let icon: String
    let title: String
    let message: String
    @ViewBuilder var footer: () -> Footer

    var body: some View {
        VStack(spacing: 14) {
            FydeIconTile(systemName: icon, tone: .accent, size: 64)
            Text(title)
                .font(FydeTheme.serif(22, relativeTo: .title3))
                .foregroundStyle(FydeTheme.ink)
                .multilineTextAlignment(.center)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(FydeTheme.inkSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
            footer()
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
    }
}

extension FydeEmptyState where Footer == EmptyView {
    init(icon: String, title: String, message: String) {
        self.init(icon: icon, title: title, message: message, footer: { EmptyView() })
    }
}

/// Wrapping layout for chips that should center themselves across rows.
struct FydeFlowLayout: Layout {
    var spacing: CGFloat = 8
    var alignment: HorizontalAlignment = .center

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = makeRows(maxWidth: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.reduce(0) { $0 + $1.height } + CGFloat(max(0, rows.count - 1)) * spacing
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = makeRows(maxWidth: bounds.width, subviews: subviews)
        var y = bounds.minY
        for row in rows {
            var x: CGFloat
            switch alignment {
            case .leading: x = bounds.minX
            case .trailing: x = bounds.maxX - row.width
            default: x = bounds.minX + (bounds.width - row.width) / 2
            }
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func makeRows(maxWidth: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            if needed > maxWidth, !current.indices.isEmpty {
                rows.append(current)
                current = Row()
            }
            current.width = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            current.height = max(current.height, size.height)
            current.indices.append(index)
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}

// MARK: - Toast

struct FydeToast: View {
    let text: String
    var onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            FydeMark(size: 22)
            Text(text)
                .font(.footnote.weight(.medium))
                .foregroundStyle(FydeTheme.ink)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(FydeTheme.muted)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 10)
        .background(FydeTheme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(FydeTheme.line, lineWidth: 1))
        .shadow(color: Color.black.opacity(0.12), radius: 18, y: 6)
        .frame(maxWidth: 520)
        .padding(.horizontal, 16)
    }
}

// MARK: - Dates & Formatting

@MainActor
enum FydeFormat {
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func date(_ string: String) -> Date? {
        iso.date(from: string) ?? isoFractional.date(from: string)
    }

    static func time(_ string: String) -> String? {
        date(string)?.formatted(date: .omitted, time: .shortened)
    }

    static func relative(_ string: String) -> String? {
        guard let d = date(string) else { return nil }
        if abs(d.timeIntervalSinceNow) < 60 { return "Just now" }
        return d.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }

    static func dayLabel(_ date: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "Today" }
        if cal.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }

    static func timestamp(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded()))
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    static func bytes(_ count: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
    }
}
