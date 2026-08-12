import AppKit
import Foundation

private func uninstallerCandidates() -> [URL] {
    let relative = "GLaDOS.app/Contents/Resources/scripts/uninstall-desktop-app.sh"
    let diskImage = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent(relative)
    let installed = URL(fileURLWithPath: "/Applications").appendingPathComponent(relative)
    return [diskImage, installed]
}

private func showResult(title: String, message: String, style: NSAlert.Style) {
    let alert = NSAlert()
    alert.alertStyle = style
    alert.messageText = title
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    alert.runModal()
}

private func runUninstaller(script: URL, arguments: [String]) throws -> (status: Int32, output: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [script.path] + arguments
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output
    try process.run()
    process.waitUntilExit()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return (process.terminationStatus, text)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)

        guard let script = uninstallerCandidates().first(where: {
            FileManager.default.isExecutableFile(atPath: $0.path)
        }) else {
            showResult(
                title: "GLaDOS was not found",
                message: "The uninstaller could not find GLaDOS in this disk image or in /Applications.",
                style: .critical
            )
            NSApp.terminate(nil)
            return
        }

        let purge = NSButton(checkboxWithTitle: "Also remove local operator data and the GLaDOS LiteLLM Keychain item", target: nil, action: nil)
        purge.state = .off
        purge.toolTip = "Purged filesystem data is moved to Trash. Developer certificates, notarization credentials, Homebrew, and assessment toolchains are never removed."

        let confirmation = NSAlert()
        confirmation.alertStyle = .warning
        confirmation.messageText = "Uninstall GLaDOS?"
        confirmation.informativeText = "The normal uninstall moves /Applications/GLaDOS.app to Trash, removes GLaDOS MITM CA trust, and preserves ~/.glados for a future reinstall."
        confirmation.accessoryView = purge
        confirmation.addButton(withTitle: "Uninstall")
        confirmation.addButton(withTitle: "Cancel")

        guard confirmation.runModal() == .alertFirstButtonReturn else {
            NSApp.terminate(nil)
            return
        }

        do {
            let result = try runUninstaller(
                script: script,
                arguments: ["--yes"] + (purge.state == .on ? ["--purge-data"] : [])
            )
            if result.status == 0 {
                showResult(
                    title: "GLaDOS was uninstalled",
                    message: result.output.isEmpty ? "The uninstall completed successfully." : result.output,
                    style: .informational
                )
            } else {
                showResult(
                    title: "GLaDOS could not be uninstalled",
                    message: result.output.isEmpty ? "The uninstaller exited with status \(result.status)." : result.output,
                    style: .critical
                )
            }
        } catch {
            showResult(title: "GLaDOS could not be uninstalled", message: error.localizedDescription, style: .critical)
        }
        NSApp.terminate(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

let commandLineArguments = Array(CommandLine.arguments.dropFirst())
if commandLineArguments.contains("--dry-run") {
    guard let script = uninstallerCandidates().first(where: {
        FileManager.default.isExecutableFile(atPath: $0.path)
    }) else {
        FileHandle.standardError.write(Data("GLaDOS uninstaller script was not found.\n".utf8))
        exit(1)
    }
    do {
        let result = try runUninstaller(script: script, arguments: commandLineArguments)
        if !result.output.isEmpty { print(result.output) }
        exit(result.status)
    } catch {
        FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
        exit(1)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
