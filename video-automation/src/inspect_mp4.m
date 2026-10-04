// Objective-C fallback for inspect_mp4.swift (same CLI, same JSON keys).
// Reports geometry, duration, codec and audio presence, and proves the file is
// playable by decoding a frame near the start and near the end.

#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#include <math.h>
#include <stdio.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 2) {
            fprintf(stderr, "usage: inspect_mp4 FILE\n");
            return 2;
        }
        NSString *path = [NSString stringWithUTF8String:argv[1]];
        if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
            fprintf(stderr, "inspect error: file not found: %s\n", argv[1]);
            return 1;
        }
        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path]
                                                options:@{AVURLAssetPreferPreciseDurationAndTimingKey: @YES}];
        AVAssetTrack *track = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
        if (track == nil) {
            fprintf(stderr, "inspect error: No video track\n");
            return 1;
        }
        NSUInteger audioTracks = [asset tracksWithMediaType:AVMediaTypeAudio].count;
        CGSize display = CGSizeApplyAffineTransform(track.naturalSize, track.preferredTransform);
        float fps = track.nominalFrameRate;
        FourCharCode codec = 0;
        id description = track.formatDescriptions.firstObject;
        if (description != nil) {
            codec = CMFormatDescriptionGetMediaSubType((__bridge CMFormatDescriptionRef)description);
        }
        double seconds = CMTimeGetSeconds(asset.duration);

        AVAssetImageGenerator *generator = [AVAssetImageGenerator assetImageGeneratorWithAsset:asset];
        generator.appliesPreferredTrackTransform = YES;
        generator.requestedTimeToleranceBefore = kCMTimeZero;
        generator.requestedTimeToleranceAfter = kCMTimeZero;
        BOOL decodable = isfinite(seconds) && seconds > 0;
        double probes[2] = {0.5, MAX(0.5, seconds - 0.5)};
        for (int i = 0; i < 2 && decodable; i++) {
            NSError *probeError = nil;
            CGImageRef image = [generator copyCGImageAtTime:CMTimeMakeWithSeconds(probes[i], 600)
                                                 actualTime:NULL
                                                      error:&probeError];
            if (image == NULL) {
                decodable = NO;
            } else {
                if (CGImageGetWidth(image) == 0 || CGImageGetHeight(image) == 0) {
                    decodable = NO;
                }
                CGImageRelease(image);
            }
        }

        NSNumber *bytes = [[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil][NSFileSize] ?: @0;
        char fourcc[4] = {
            (char)((codec >> 24) & 255), (char)((codec >> 16) & 255),
            (char)((codec >> 8) & 255), (char)(codec & 255),
        };
        NSString *codecText = [[NSString alloc] initWithBytes:fourcc length:4 encoding:NSASCIIStringEncoding] ?: @"????";
        NSDictionary *payload = @{
            @"duration": @(isfinite(seconds) ? seconds : 0.0),
            @"width": @(fabs(display.width)),
            @"height": @(fabs(display.height)),
            @"fps": @(isfinite(fps) ? fps : 0.0f),
            @"codec_fourcc": codecText,
            @"audio_tracks": @(audioTracks),
            @"decodable": @(decodable),
            @"bytes": bytes,
        };
        NSError *error = nil;
        NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:NSJSONWritingSortedKeys error:&error];
        if (data == nil) {
            fprintf(stderr, "inspect error: %s\n", error.localizedDescription.UTF8String);
            return 1;
        }
        printf("%s\n", [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    }
    return 0;
}
