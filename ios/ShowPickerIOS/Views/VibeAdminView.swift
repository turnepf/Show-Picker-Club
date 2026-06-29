import SwiftUI

// Operator tool: generate Claude-based taste traits for shows that lack them,
// or refresh existing scores. POST /api/admin-vibe-fill. Foreground fill runs
// batches in a loop; re-score can also run in the background via the cron.
struct VibeAdminView: View {
    @State private var status: VibeFillStatus?
    @State private var running = false
    @State private var processed = 0
    @State private var unknown = 0
    @State private var errors = 0
    @State private var remaining = 0
    @State private var log: [String] = []
    @State private var busy = false

    var body: some View {
        List {
            Section("Status") {
                LabeledContent("Unscored titles", value: "\(status?.fillRemaining ?? 0)")
                if status?.rescoreActive == true {
                    LabeledContent("Re-score remaining", value: "\(status?.rescoreRemaining ?? 0)")
                    if let started = status?.rescoreStartedAt {
                        LabeledContent("Re-score started", value: started)
                    }
                }
            }

            Section {
                if running {
                    Button("Stop", role: .destructive) { running = false }
                } else {
                    Button("Fill missing scores") { Task { await fillLoop() } }
                        .disabled((status?.fillRemaining ?? 0) == 0 || busy)
                }
            } header: {
                Text("Fill")
            } footer: {
                Text("Scores every title with no traits yet, one batch at a time. Safe to stop and resume.")
            }

            Section {
                if status?.rescoreActive == true {
                    Button("Cancel background re-score", role: .destructive) {
                        Task { await toggleRescore(start: false) }
                    }.disabled(busy)
                } else {
                    Button("Start background re-score") {
                        Task { await toggleRescore(start: true) }
                    }.disabled(busy || running)
                }
            } header: {
                Text("Re-score")
            } footer: {
                Text("Refreshes traits for every show. The background job continues via the daily cron after you leave this screen.")
            }

            if processed + unknown + errors > 0 {
                Section("This session") {
                    LabeledContent("Scored", value: "\(processed)")
                    LabeledContent("Unknown", value: "\(unknown)")
                    LabeledContent("Errors", value: "\(errors)")
                }
            }

            if !log.isEmpty {
                Section("Log") {
                    ForEach(Array(log.enumerated()), id: \.offset) { _, line in
                        Text(line).font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Vibe Admin")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadStatus() }
    }

    private func loadStatus() async {
        status = try? await API.vibeFillStatus()
    }

    private func fillLoop() async {
        running = true
        while running {
            do {
                let r = try await API.vibeFill(count: 5, rescore: false)
                if let e = r.error {
                    log.insert("Error: \(e)", at: 0)
                    break
                }
                processed += r.processed ?? 0
                unknown += r.unknown ?? 0
                errors += r.errors ?? 0
                remaining = r.remaining ?? 0
                log.insert("Batch: \(r.processed ?? 0) ok · \(r.unknown ?? 0) unknown · \(r.errors ?? 0) err — \(remaining) left", at: 0)
                if remaining <= 0 { break }
            } catch {
                log.insert("Network error — stopped.", at: 0)
                break
            }
        }
        running = false
        await loadStatus()
    }

    private func toggleRescore(start: Bool) async {
        busy = true
        defer { busy = false }
        if start {
            _ = try? await API.startBackgroundRescore()
        } else {
            _ = try? await API.cancelBackgroundRescore()
        }
        await loadStatus()
    }
}
