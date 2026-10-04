import AVFoundation
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("usage: inspect_mp4.swift FILE\n", stderr)
    exit(2)
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let asset = AVURLAsset(url: url)

Task {
    do {
        let duration = try await asset.load(.duration)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        guard let track = tracks.first else { throw NSError(domain: "inspect", code: 1) }
        let size = try await track.load(.naturalSize)
        let transform = try await track.load(.preferredTransform)
        let display = size.applying(transform)
        let fps = try await track.load(.nominalFrameRate)
        let codec = try await track.load(.formatDescriptions).first.map { CMFormatDescriptionGetMediaSubType($0) } ?? 0
        let payload: [String: Any] = [
            "duration": CMTimeGetSeconds(duration),
            "width": abs(display.width),
            "height": abs(display.height),
            "fps": fps,
            "codec_fourcc": String(format: "%c%c%c%c", (codec >> 24) & 255, (codec >> 16) & 255, (codec >> 8) & 255, codec & 255)
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
        exit(0)
    } catch {
        fputs("inspect error: \(error)\n", stderr)
        exit(1)
    }
}

dispatchMain()

