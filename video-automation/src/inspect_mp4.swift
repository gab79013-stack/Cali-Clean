import AVFoundation
import CoreMedia
import Foundation

// Reports geometry, duration, codec and audio presence, and proves the file is
// playable by decoding a frame near the start and near the end.

guard CommandLine.arguments.count == 2 else {
    fputs("usage: inspect_mp4 FILE\n", stderr)
    exit(2)
}

let path = CommandLine.arguments[1]

func fourcc(_ code: FourCharCode) -> String {
    let bytes = [(code >> 24) & 255, (code >> 16) & 255, (code >> 8) & 255, code & 255]
    return String(bytes.map { Character(UnicodeScalar(UInt8($0))) })
}

func inspect(_ path: String) async throws -> [String: Any] {
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    let duration = try await asset.load(.duration)
    let tracks = try await asset.loadTracks(withMediaType: .video)
    guard let track = tracks.first else {
        throw NSError(domain: "inspect", code: 1, userInfo: [NSLocalizedDescriptionKey: "No video track"])
    }
    let audio = try await asset.loadTracks(withMediaType: .audio)
    let size = try await track.load(.naturalSize)
    let transform = try await track.load(.preferredTransform)
    let display = size.applying(transform)
    let fps = try await track.load(.nominalFrameRate)
    let descriptions = try await track.load(.formatDescriptions)
    let codec = descriptions.first.map { CMFormatDescriptionGetMediaSubType($0) } ?? 0

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    let seconds = CMTimeGetSeconds(duration)
    var decodable = true
    for probe in [0.5, max(0.5, seconds - 0.5)] {
        do {
            let result = try await generator.image(at: CMTime(seconds: probe, preferredTimescale: 600))
            if result.image.width <= 0 || result.image.height <= 0 { decodable = false }
        } catch {
            decodable = false
        }
    }
    let bytes = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)?.intValue ?? 0
    return [
        "duration": seconds,
        "width": abs(display.width),
        "height": abs(display.height),
        "fps": fps,
        "codec_fourcc": fourcc(codec),
        "audio_tracks": audio.count,
        "decodable": decodable,
        "bytes": bytes
    ]
}

Task {
    do {
        let payload = try await inspect(path)
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
        exit(0)
    } catch {
        let ns = error as NSError
        fputs("inspect error: \(error) domain=\(ns.domain) code=\(ns.code) userInfo=\(ns.userInfo)\n", stderr)
        exit(1)
    }
}

dispatchMain()
