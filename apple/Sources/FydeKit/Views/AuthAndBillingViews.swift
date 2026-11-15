import AuthenticationServices
import SwiftUI

/// Legacy brand names, kept as aliases of the Paper tokens in `FydeTheme`.
public enum FydeBrand {
    public static let cream = FydeTheme.paper
    public static let forestInk = FydeTheme.ink
    public static let terracotta = FydeTheme.accent
}

public struct FydeWordmarkView: View {
    public var size: CGFloat = 34

    public init(size: CGFloat = 34) {
        self.size = size
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 1) {
            Text("fyde")
                .font(.system(size: size, weight: .heavy, design: .default))
                .tracking(-size * 0.04)
                .foregroundStyle(FydeBrand.forestInk)
            Circle()
                .fill(FydeBrand.terracotta)
                .frame(width: size * 0.22, height: size * 0.22)
                .offset(y: -size * 0.03)
        }
    }
}

public struct FydeAuthGateView: View {
    @Bindable var store: FydeStore
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var colorScheme

    private enum Mode: Hashable {
        case signIn, signUp
    }

    private enum Field: Hashable {
        case email, handle, password
    }

    @State private var mode: Mode = .signIn
    @State private var email = ""
    @State private var handle = ""
    @State private var password = ""
    @State private var messageBanner: String?
    @State private var isBusy = false
    @FocusState private var focus: Field?

    /// Native Sign in with Apple stops growing at 375pt on macOS, so the whole
    /// column is capped below that to keep every control the same width.
    private let columnWidth: CGFloat = 360

    public init(store: FydeStore) {
        self.store = store
    }

    // MARK: Validation

    /// Mirrors the edge's `normalizeHandle`: lowercase a–z, 0–9 and _, max 24.
    private static func normalizeHandle(_ raw: String) -> String {
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789_")
        return String(raw.lowercased().filter { allowed.contains($0) }.prefix(24))
    }

    private var trimmedEmail: String {
        email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var emailLooksValid: Bool {
        let parts = trimmedEmail.split(separator: "@")
        return parts.count == 2 && parts[1].contains(".")
    }

    private var canSubmit: Bool {
        guard !isBusy else { return false }
        switch mode {
        case .signIn:
            return !handle.isEmpty && !password.isEmpty
        case .signUp:
            return emailLooksValid && handle.count >= 3 && password.count >= 6
        }
    }

    // MARK: Body

    public var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                VStack(spacing: 10) {
                    FydeWordmarkView(size: 44)
                    Text("Search by memory. Share in a sentence.")
                        .font(.subheadline)
                        .foregroundStyle(FydeTheme.inkSecondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.top, 44)

                VStack(spacing: 12) {
                    appleButton
                    googleButton
                    orDivider
                    fields
                    if let msg = messageBanner {
                        banner(msg)
                    }
                    submitButton
                    modeSwitch
                }
                .frame(maxWidth: columnWidth)
                .padding(22)
                .background(FydeTheme.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .strokeBorder(FydeTheme.line, lineWidth: 1)
                )
                .shadow(color: Color.black.opacity(0.04), radius: 14, y: 4)
                .padding(.bottom, 28)
            }
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(FydeTheme.paper.ignoresSafeArea())
        .tint(FydeTheme.accent)
        .animation(.easeOut(duration: 0.2), value: mode)
        .animation(.easeOut(duration: 0.2), value: messageBanner)
    }

    // MARK: Social

    private var appleButton: some View {
        SignInWithAppleButton(mode == .signUp ? .signUp : .signIn) { request in
            request.requestedScopes = [.fullName, .email]
        } onCompletion: { result in
            handleAppleResult(result)
        }
        .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
        .frame(maxWidth: .infinity)
        .frame(height: 48)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .id("apple-\(mode == .signUp)-\(colorScheme == .dark)")
    }

    private var googleButton: some View {
        Button {
            if let url = URL(string: "\(store.relayBaseURL)/api/auth/google/start") {
                openURL(url)
            }
        } label: {
            HStack(spacing: 10) {
                Text("G")
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                    .foregroundStyle(FydeTheme.accent)
                Text(mode == .signUp ? "Sign up with Google" : "Sign in with Google")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(FydeTheme.ink)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(FydeTheme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(FydeTheme.line, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var orDivider: some View {
        HStack(spacing: 12) {
            Rectangle().fill(FydeTheme.line).frame(height: 1)
            Text("or")
                .font(.footnote)
                .foregroundStyle(FydeTheme.muted)
            Rectangle().fill(FydeTheme.line).frame(height: 1)
        }
        .padding(.vertical, 6)
    }

    // MARK: Fields

    @ViewBuilder
    private var fields: some View {
        if mode == .signUp {
            fieldBox(icon: "envelope", field: .email) {
                TextField("Email", text: $email)
                    .textFieldStyle(.plain)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    .textContentType(.emailAddress)
                    #endif
                    .focused($focus, equals: .email)
                    .submitLabel(.next)
                    .onSubmit { focus = .handle }
            }
            .transition(.move(edge: .top).combined(with: .opacity))
        }

        fieldBox(icon: "at", field: .handle) {
            TextField(mode == .signUp ? "Choose a handle" : "Handle", text: $handle)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                .textContentType(.username)
                #endif
                .focused($focus, equals: .handle)
                .submitLabel(.next)
                .onSubmit { focus = .password }
                .onChange(of: handle) { _, newValue in
                    let cleaned = Self.normalizeHandle(newValue)
                    if cleaned != newValue { handle = cleaned }
                }
        }

        fieldBox(icon: "lock", field: .password) {
            SecureField(mode == .signUp ? "Password (6+ characters)" : "Password", text: $password)
                .textFieldStyle(.plain)
                #if os(iOS)
                .textContentType(mode == .signUp ? .newPassword : .password)
                #endif
                .focused($focus, equals: .password)
                .submitLabel(.go)
                .onSubmit(submit)
        }
    }

    private func fieldBox<Content: View>(icon: String, field: Field, @ViewBuilder content: () -> Content) -> some View {
        let isFocused = focus == field
        return HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(isFocused ? FydeTheme.accent : FydeTheme.muted)
                .frame(width: 18)
            content()
                .font(.body)
                .foregroundStyle(FydeTheme.ink)
        }
        .padding(.horizontal, 14)
        .frame(height: 48)
        .background(FydeTheme.paper, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(isFocused ? FydeTheme.accent.opacity(0.5) : FydeTheme.line, lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .onTapGesture { focus = field }
    }

    private func banner(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.footnote)
            Text(text)
                .font(.footnote.weight(.medium))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(FydeTheme.accent)
        .padding(12)
        .background(FydeTheme.accentSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .transition(.opacity)
    }

    // MARK: Actions

    private var submitButton: some View {
        Button(action: submit) {
            HStack(spacing: 8) {
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                }
                Text(mode == .signUp ? "Create account" : "Sign in")
            }
            .frame(height: 48)
        }
        .buttonStyle(FydePrimaryButtonStyle())
        .disabled(!canSubmit)
        .padding(.top, 4)
    }

    private var modeSwitch: some View {
        HStack(spacing: 4) {
            Text(mode == .signIn ? "New to fyde?" : "Already have an account?")
                .foregroundStyle(FydeTheme.inkSecondary)
            Button(mode == .signIn ? "Sign up" : "Sign in") {
                messageBanner = nil
                focus = nil
                mode = (mode == .signIn) ? .signUp : .signIn
            }
            .buttonStyle(.plain)
            .fontWeight(.semibold)
            .foregroundStyle(FydeTheme.accent)
        }
        .font(.footnote)
        .padding(.top, 4)
    }

    private func submit() {
        guard canSubmit else { return }
        focus = nil
        let currentMode = mode
        let currentEmail = trimmedEmail
        let currentHandle = handle
        let currentPassword = password
        Task {
            isBusy = true
            messageBanner = nil
            let error: String?
            switch currentMode {
            case .signIn:
                // The edge's /api/auth/login accepts a handle in its `email` field.
                error = await store.authenticateWithPassword(
                    email: currentHandle,
                    password: currentPassword,
                    isRegister: false
                )
            case .signUp:
                error = await store.authenticateWithPassword(
                    email: currentEmail,
                    password: currentPassword,
                    handle: currentHandle,
                    isRegister: true
                )
            }
            isBusy = false
            messageBanner = error
        }
    }

    private func handleAppleResult(_ result: Result<ASAuthorization, any Error>) {
        switch result {
        case .success(let auth):
            guard let cred = auth.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = cred.identityToken,
                  let tokenStr = String(data: tokenData, encoding: .utf8) else {
                messageBanner = "Could not decode Sign in with Apple token."
                return
            }
            let fullName = [cred.fullName?.givenName, cred.fullName?.familyName]
                .compactMap { $0 }
                .joined(separator: " ")
            let mail = cred.email ?? ""
            Task {
                messageBanner = await store.authenticateWithAppleNative(
                    identityToken: tokenStr,
                    fullName: fullName,
                    email: mail
                )
            }
        case .failure(let err):
            if let authErr = err as? ASAuthorizationError, authErr.code == .canceled {
                return
            }
            messageBanner = err.localizedDescription
        }
    }
}

public struct FydeBillingSheetView: View {
    @Bindable var store: FydeStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var interval: String = "yearly"
    @State private var busyTier: PlanTier?
    @State private var notice: String?

    public init(store: FydeStore) {
        self.store = store
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack {
                        FydeWordmarkView(size: 28)
                        Spacer()
                        Picker("Billing", selection: $interval) {
                            Text("Monthly").tag("monthly")
                            Text("Yearly (-31%)").tag("yearly")
                        }
                        .pickerStyle(.segmented)
                        .frame(maxWidth: 220)
                    }

                    Text("Apple Pay, Google Pay, Link, and Card subscriptions powered by Stripe Checkout & Cloudflare R2 zero-egress edge.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    if let notice {
                        Text(notice)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(FydeBrand.terracotta)
                            .padding(10)
                            .background(FydeBrand.terracotta.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                    }

                    let currentTier = store.currentUser.planTier ?? .starter
                    ForEach(store.plans) { plan in
                        let isCurrent = currentTier == plan.tier
                        let price = (interval == "yearly" && plan.yearlyUsd > 0) ? "$\(plan.yearlyUsd)" : "$\(plan.monthlyUsd)"
                        let unit = plan.monthlyUsd == 0 ? "forever" : (interval == "yearly" ? "/ year" : "/ month")

                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Text(plan.name)
                                    .font(.headline)
                                if plan.highlighted == true {
                                    Text("POPULAR")
                                        .font(.caption2.bold())
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 3)
                                        .background(FydeBrand.terracotta, in: Capsule())
                                }
                                Spacer()
                                Text("\(price) \(unit)")
                                    .font(.subheadline.bold())
                            }

                            Text(plan.tagline)
                                .font(.caption)
                                .foregroundStyle(.secondary)

                            ForEach(plan.features, id: \.self) { feat in
                                HStack(alignment: .top, spacing: 6) {
                                    Text("✓")
                                        .foregroundStyle(FydeBrand.terracotta)
                                        .bold()
                                    Text(feat)
                                        .font(.caption)
                                }
                            }

                            if plan.tier != .starter {
                                Button {
                                    Task {
                                        busyTier = plan.tier
                                        let res = await store.startPlanCheckout(tier: plan.tier, interval: interval)
                                        busyTier = nil
                                        if let url = res.checkoutURL {
                                            openURL(url)
                                            dismiss()
                                        } else if let msg = res.message {
                                            notice = msg
                                        }
                                    }
                                } label: {
                                    Text(isCurrent ? "Current Plan" : (busyTier == plan.tier ? "Preparing Checkout…" : "Choose \(plan.name)"))
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.white)
                                        .frame(maxWidth: .infinity, minHeight: 38)
                                        .background(
                                            isCurrent ? Color.secondary : (plan.highlighted == true ? FydeBrand.terracotta : FydeBrand.forestInk),
                                            in: RoundedRectangle(cornerRadius: 10)
                                        )
                                }
                                .buttonStyle(.plain)
                                .disabled(isCurrent || busyTier != nil)
                            }
                        }
                        .padding(16)
                        .background(.background, in: RoundedRectangle(cornerRadius: 16))
                        .overlay(
                            RoundedRectangle(cornerRadius: 16)
                                .strokeBorder(plan.highlighted == true ? FydeBrand.forestInk : Color.secondary.opacity(0.22), lineWidth: plan.highlighted == true ? 2 : 1)
                        )
                    }
                }
                .padding(20)
            }
            .background(FydeBrand.cream.ignoresSafeArea())
            .navigationTitle("fyde. Plans")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 560)
        #endif
    }
}
