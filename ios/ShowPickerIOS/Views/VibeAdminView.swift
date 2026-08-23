import SwiftUI
import UIKit

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
    @State private var batchSize = 5
    @State private var copied = false

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
                Stepper("Batch size: \(batchSize)", value: $batchSize, in: 1...25)
                    .disabled(running)
            } header: {
                Text("Batch size")
            } footer: {
                Text("Titles per call. Bigger batches finish sooner but take longer per request — drop it if calls start timing out.")
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
                    // Foreground: same loop as Fill, but re-scoring titles
                    // that already have traits. Stays on this screen so the
                    // per-title log is visible while it runs.
                    Button("Re-score here, now") { Task { await fillLoop(rescore: true) } }
                        .disabled(busy || running)
                }
            } header: {
                Text("Re-score")
            } footer: {
                Text("Refreshes traits for every show. The background job continues via the daily cron after you leave this screen; running it here shows each title as it goes.")
            }

            if processed + unknown + errors > 0 {
                Section("This session") {
                    LabeledContent("Scored", value: "\(processed)")
                    LabeledContent("Unknown", value: "\(unknown)")
                    LabeledContent("Errors", value: "\(errors)")
                }
            }

            if !log.isEmpty {
                Section {
                    ForEach(Array(log.enumerated()), id: \.offset) { _, line in
                        Text(line).font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                } header: {
                    HStack {
                        Text("Log")
                        Spacer()
                        Button("Copy") {
                            UIPasteboard.general.string = log.reversed().joined(separator: "\n")
                            copied = true
                        }
                        .font(.caption)
                        .textCase(nil)
                    }
                } footer: {
                    if copied { Text("Copied to the clipboard.") }
                }
            }
        }
        .navigationTitle("Vibe Admin")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadStatus() }
        // Status moves while a background re-score runs; poll on the same
        // 20s cadence as the web page rather than making the operator leave
        // and come back to see progress.
        .task(id: status?.rescoreActive) {
            guard status?.rescoreActive == true else { return }
            while !Task.isCancelled && status?.rescoreActive == true {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                if Task.isCancelled { return }
                await loadStatus()
            }
        }
    }

    private func loadStatus() async {
        status = try? await API.vibeFillStatus()
    }

    private func fillLoop(rescore: Bool = false) async {
        running = true
        while running {
            do {
                let r = try await API.vibeFill(count: batchSize, rescore: rescore)
                if let e = r.error {
                    log.insert("Error: \(e)", at: 0)
                    break
                }
                processed += r.processed ?? 0
                unknown += r.unknown ?? 0
                errors += r.errors ?? 0
                remaining = r.remaining ?? 0
                log.insert("Batch: \(r.processed ?? 0) ok · \(r.unknown ?? 0) unknown · \(r.errors ?? 0) err — \(remaining) left", at: 0)
                // Per-title rows under the batch line — a summary can't say
                // WHICH title came back unknown, which is the thing worth
                // acting on.
                for row in (r.results ?? []).reversed() {
                    log.insert("  \(row.line)", at: 0)
                }
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
            await ErrorCenter.run("start the rescore", { _ = try await API.startBackgroundRescore() })
        } else {
            await ErrorCenter.run("cancel the rescore", { _ = try await API.cancelBackgroundRescore() })
        }
        await loadStatus()
    }
}
