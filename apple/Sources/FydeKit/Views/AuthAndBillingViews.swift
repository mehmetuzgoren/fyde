import AuthenticationServices
import SwiftUI

public enum FydeBrand {
    public static let cream = Color(red: 248.0 / 255.0, green: 249.0 / 255.0, blue: 244.0 / 255.0)
    public static let forestInk = Color(red: 41.0 / 255.0, green: 48.0 / 255.0, blue: 34.0 / 255.0)
    public static let terracotta = Color(red: 191.0 / 255.0, green: 81.0 / 255.0, blue: 52.0 / 255.0)
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

    private enum AuthMode: String, CaseIterable, Identifiable {
        case otp = "Email Code"
        case password = "Password"
        case waitlist = "Waitlist"
        var id: String { rawValue }
    }

    @State private var mode: AuthMode = .otp
    @State private var isRegister = false
    @State private var email = ""
    @State private var displayName = ""
    @State private var password = ""
    @State private var inviteCode = ""

    @State private var otpSent = false
    @State private var otpCode = ""
    @State private var devPreviewCode: String?
    @State private var messageBanner: String?
    @State private var isBusy = false

    public init(store: FydeStore) {
        self.store = store
    }

    public var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                // Brand Header
                VStack(spacing: 10) {
                    FydeWordmarkView(size: 44)
                    Text("Search by memory. Share in a sentence.")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.top, 28)

                // Main Auth Card
                VStack(alignment: .leading, spacing: 16) {
                    // Sign in with Apple (Native AuthenticationServices)
                    SignInWithAppleButton(.signIn) { request in
                        request.requestedScopes = [.fullName, .email]
                    } onCompletion: { result in
                        handleAppleResult(result)
                    }
                    .signInWithAppleButtonStyle(.black)
                    .frame(height: 46)
                    .clipShape(RoundedRectangle(cornerRadius: 12))

                    // Continue with Google
                    Button {
                        if let url = URL(string: "\(store.relayBaseURL)/api/auth/google/start") {
                            openURL(url)
                        }
                    } label: {
                        HStack(spacing: 8) {
                            Text("G")
                                .font(.headline.weight(.black))
                                .foregroundStyle(FydeBrand.terracotta)
                            Text("Continue with Google")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.primary)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(
                            RoundedRectangle(cornerRadius: 12)
                                .strokeBorder(Color.secondary.opacity(0.3), lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)

                    Picker("Method", selection: $mode) {
                        ForEach(AuthMode.allCases) { m in
                            Text(m.rawValue).tag(m)
                        }
                    }
                    .pickerStyle(.segmented)

                    if let msg = messageBanner {
                        Text(msg)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(FydeBrand.terracotta)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(FydeBrand.terracotta.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                    }

                    switch mode {
                    case .otp:
                        otpSection
                    case .password:
                        passwordSection
                    case .waitlist:
                        waitlistSection
                    }
                }
                .padding(22)
                .background(.background, in: RoundedRectangle(cornerRadius: 22))
                .overlay(
                    RoundedRectangle(cornerRadius: 22)
                        .strokeBorder(FydeBrand.forestInk.opacity(0.12), lineWidth: 1)
                )
                .frame(maxWidth: 460)

                // Quick Sandbox Peer Switcher
                VStack(spacing: 10) {
                    Text("INSTANT P2P PREVIEW ACCOUNTS")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)

                    HStack(spacing: 8) {
                        ForEach(["mehmet", "maya", "alex"], id: \.self) { handle in
                            Button {
                                Task { await store.signInDemo(handle: handle) }
                            } label: {
                                Text("@\(handle)")
                                    .font(.caption.weight(.semibold))
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 7)
                                    .background(FydeBrand.forestInk.opacity(0.08), in: Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                // Relay Edge Endpoint Selector
                VStack(spacing: 6) {
                    HStack(spacing: 8) {
                        Button("Local Edge (:8787)") {
                            store.relayBaseURL = "http://127.0.0.1:8787"
                        }
                        .font(.caption2.weight(.semibold))

                        Text("•").foregroundStyle(.secondary)

                        Button("fyde.izbirakin.com") {
                            store.relayBaseURL = "https://fyde.izbirakin.com"
                        }
                        .font(.caption2.weight(.semibold))
                    }
                    Text("Active Edge: \(store.relayBaseURL)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .padding(.bottom, 28)
            }
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity)
        }
        .background(FydeBrand.cream.ignoresSafeArea())
    }

    @ViewBuilder
    private var otpSection: some View {
        if !otpSent {
            VStack(spacing: 10) {
                emailField("you@izbirakin.com")
                Button {
                    Task {
                        isBusy = true
                        let res = await store.sendEmailOTP(email: email)
                        isBusy = false
                        if res.sent {
                            otpSent = true
                            devPreviewCode = res.previewHint
                            messageBanner = nil
                        } else {
                            messageBanner = res.error
                        }
                    }
                } label: {
                    primaryLabel(isBusy ? "Sending Code…" : "Send 6-Digit Email Code")
                }
                .buttonStyle(.plain)
                .disabled(email.isEmpty || isBusy)
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                if let hint = devPreviewCode {
                    HStack {
                        Text("Preview Code: \(hint)")
                            .font(.caption.monospaced().bold())
                        Spacer()
                        Button("Autofill") {
                            otpCode = hint
                        }
                        .font(.caption.bold())
                        .foregroundStyle(FydeBrand.terracotta)
                    }
                    .padding(8)
                    .background(FydeBrand.forestInk.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                }
                TextField("6-Digit Code", text: $otpCode)
                    .textFieldStyle(.roundedBorder)
                TextField("Display Name (optional)", text: $displayName)
                    .textFieldStyle(.roundedBorder)
                HStack(spacing: 8) {
                    Button {
                        Task {
                            isBusy = true
                            messageBanner = await store.verifyEmailOTP(email: email, code: otpCode, displayName: displayName)
                            isBusy = false
                        }
                    } label: {
                        primaryLabel(isBusy ? "Verifying…" : "Verify & Sign In")
                    }
                    .buttonStyle(.plain)

                    Button("Back") {
                        otpSent = false
                        devPreviewCode = nil
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
    }

    private var passwordSection: some View {
        VStack(spacing: 10) {
            if isRegister {
                TextField("Display Name", text: $displayName)
                    .textFieldStyle(.roundedBorder)
            }
            emailField("Email or @handle")
            SecureField("Password (6+ chars)", text: $password)
                .textFieldStyle(.roundedBorder)
            if isRegister {
                TextField("Waitlist Invite Code (optional)", text: $inviteCode)
                    .textFieldStyle(.roundedBorder)
            }
            Button {
                Task {
                    isBusy = true
                    messageBanner = await store.authenticateWithPassword(
                        email: email,
                        password: password,
                        displayName: displayName,
                        inviteCode: inviteCode,
                        isRegister: isRegister
                    )
                    isBusy = false
                }
            } label: {
                primaryLabel(isBusy ? "Signing in…" : (isRegister ? "Create Account" : "Sign In"))
            }
            .buttonStyle(.plain)
            .disabled(email.isEmpty || password.isEmpty || isBusy)

            Button(isRegister ? "Have an account? Sign in" : "New to fyde.? Create password account") {
                isRegister.toggle()
            }
            .font(.caption.weight(.semibold))
            .buttonStyle(.plain)
        }
    }

    private var waitlistSection: some View {
        VStack(spacing: 10) {
            TextField("First Name", text: $displayName)
                .textFieldStyle(.roundedBorder)
            emailField("Enter email for TestFlight & Web access")
            Button {
                Task {
                    isBusy = true
                    messageBanner = await store.joinWaitlist(email: email, name: displayName)
                    isBusy = false
                }
            } label: {
                Text(isBusy ? "Joining…" : "Reserve Spot on fyde.izbirakin.com")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 42)
                    .background(FydeBrand.terracotta, in: RoundedRectangle(cornerRadius: 11))
            }
            .buttonStyle(.plain)
            .disabled(email.isEmpty || isBusy)
        }
    }

    private func emailField(_ placeholder: String) -> some View {
        TextField(placeholder, text: $email)
            .textFieldStyle(.roundedBorder)
            .autocorrectionDisabled()
            #if os(iOS)
            .textInputAutocapitalization(.never)
            .keyboardType(.emailAddress)
            #endif
    }

    private func primaryLabel(_ text: String) -> some View {
        Text(text)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(FydeBrand.cream)
            .frame(maxWidth: .infinity, minHeight: 42)
            .background(FydeBrand.forestInk, in: RoundedRectangle(cornerRadius: 11))
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
