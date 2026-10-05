// Objective-C fallback for render_mp4.swift (same CLI, same JSON output).
// Used only when the Swift toolchain cannot build against the SDK. Compiled with
// clang -fno-modules, so no module maps are read. Headless: CoreVideo +
// AVFoundation, no AppKit.
//
// Reads exactly FRAMES raw BGRA frames (WIDTH*HEIGHT*4 bytes each) from stdin.
// Every frame is a CVPixelBuffer created directly with CVPixelBufferCreate
// (never taken from the writer adaptor); the adaptor is used only to append.

#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static NSError *RenderError(NSString *message) {
    return [NSError errorWithDomain:@"caliclean.render" code:1 userInfo:@{NSLocalizedDescriptionKey: message}];
}

static NSString *Describe(NSError *error) {
    if (error == nil) {
        return @"unknown error";
    }
    NSMutableString *text = [NSMutableString stringWithFormat:@"%@ domain=%@ code=%ld",
                             error.localizedDescription, error.domain, (long)error.code];
    if (error.userInfo.count > 0) {
        [text appendFormat:@" userInfo=%@", error.userInfo];
    }
    NSError *underlying = error.userInfo[NSUnderlyingErrorKey];
    if (underlying != nil) {
        [text appendFormat:@" underlying=%@#%ld %@", underlying.domain, (long)underlying.code, underlying.localizedDescription];
    }
    return text;
}

static BOOL Fail(NSError **error, NSError *value) {
    if (error != NULL) {
        *error = value;
    }
    return NO;
}

static BOOL ReadExactly(void *pointer, size_t count) {
    size_t done = 0;
    while (done < count) {
        size_t n = fread((char *)pointer + done, 1, count - done, stdin);
        if (n == 0) {
            return NO;
        }
        done += n;
    }
    return YES;
}

// Explicit BGRA attributes shared by every buffer and by the writer adaptor.
static NSDictionary *BufferAttributes(int width, int height) {
    return @{
        (__bridge NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
        (__bridge NSString *)kCVPixelBufferWidthKey: @(width),
        (__bridge NSString *)kCVPixelBufferHeightKey: @(height),
        (__bridge NSString *)kCVPixelBufferCGImageCompatibilityKey: @YES,
        (__bridge NSString *)kCVPixelBufferCGBitmapContextCompatibilityKey: @YES,
        (__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey: @{},
    };
}

// Creates one buffer and fills it from stdin. Returns +1 or NULL.
static CVPixelBufferRef ReadFrame(NSDictionary *attributes, size_t width, size_t height, int index, NSError **error) {
    CVPixelBufferRef buffer = NULL;
    CVReturn status = CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
                                          (__bridge CFDictionaryRef)attributes, &buffer);
    if (status != kCVReturnSuccess || buffer == NULL) {
        if (buffer != NULL) {
            CVPixelBufferRelease(buffer);
        }
        Fail(error, RenderError([NSString stringWithFormat:@"CVPixelBufferCreate failed (CVReturn %d) at frame %d", status, index]));
        return NULL;
    }
    if (CVPixelBufferGetWidth(buffer) != width || CVPixelBufferGetHeight(buffer) != height ||
        CVPixelBufferGetPixelFormatType(buffer) != kCVPixelFormatType_32BGRA) {
        CVPixelBufferRelease(buffer);
        Fail(error, RenderError(@"CVPixelBufferCreate returned an unexpected geometry or pixel format"));
        return NULL;
    }
    status = CVPixelBufferLockBaseAddress(buffer, 0);
    if (status != kCVReturnSuccess) {
        CVPixelBufferRelease(buffer);
        Fail(error, RenderError([NSString stringWithFormat:@"CVPixelBufferLockBaseAddress failed (CVReturn %d)", status]));
        return NULL;
    }
    unsigned char *base = (unsigned char *)CVPixelBufferGetBaseAddress(buffer);
    size_t bytesPerRow = CVPixelBufferGetBytesPerRow(buffer);
    size_t rowBytes = width * 4;
    BOOL complete = base != NULL && bytesPerRow >= rowBytes;
    for (size_t y = 0; complete && y < height; y++) {
        complete = ReadExactly(base + y * bytesPerRow, rowBytes);
    }
    status = CVPixelBufferUnlockBaseAddress(buffer, 0);
    if (!complete) {
        CVPixelBufferRelease(buffer);
        Fail(error, RenderError(base == NULL ? @"Missing pixel buffer base address"
                                             : [NSString stringWithFormat:@"stdin ended early at frame %d", index]));
        return NULL;
    }
    if (status != kCVReturnSuccess) {
        CVPixelBufferRelease(buffer);
        Fail(error, RenderError([NSString stringWithFormat:@"CVPixelBufferUnlockBaseAddress failed (CVReturn %d)", status]));
        return NULL;
    }
    return buffer;
}

static BOOL Render(NSString *outputPath, int width, int height, int fps, int frameCount, NSError **error) {
    NSURL *url = [NSURL fileURLWithPath:outputPath];
    NSFileManager *files = [NSFileManager defaultManager];
    if ([files fileExistsAtPath:outputPath] && ![files removeItemAtURL:url error:error]) {
        return NO;
    }
    AVAssetWriter *writer = [AVAssetWriter assetWriterWithURL:url fileType:AVFileTypeMPEG4 error:error];
    if (writer == nil) {
        return NO;
    }
    // Put the moov atom first so the file plays back immediately anywhere.
    writer.shouldOptimizeForNetworkUse = YES;
    NSDictionary *settings = @{
        AVVideoCodecKey: AVVideoCodecTypeH264,
        AVVideoWidthKey: @(width),
        AVVideoHeightKey: @(height),
        AVVideoCompressionPropertiesKey: @{
            AVVideoAverageBitRateKey: @8000000,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoExpectedSourceFrameRateKey: @(fps),
            AVVideoMaxKeyFrameIntervalKey: @(fps * 2),
        },
    };
    AVAssetWriterInput *input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:settings];
    input.expectsMediaDataInRealTime = NO;
    NSDictionary *attributes = BufferAttributes(width, height);
    AVAssetWriterInputPixelBufferAdaptor *adaptor =
        [AVAssetWriterInputPixelBufferAdaptor assetWriterInputPixelBufferAdaptorWithAssetWriterInput:input
                                                                         sourcePixelBufferAttributes:attributes];
    if (![writer canAddInput:input]) {
        return Fail(error, RenderError(@"AVAssetWriter rejected video input"));
    }
    [writer addInput:input];
    if (![writer startWriting]) {
        return Fail(error, writer.error ?: RenderError(@"Writer did not start"));
    }
    [writer startSessionAtSourceTime:kCMTimeZero];

    for (int index = 0; index < frameCount; index++) {
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:30];
        while (!input.readyForMoreMediaData) {
            if (writer.status == AVAssetWriterStatusFailed) {
                return Fail(error, writer.error ?: RenderError([NSString stringWithFormat:@"Writer failed before frame %d", index]));
            }
            if ([deadline timeIntervalSinceNow] < 0) {
                return Fail(error, RenderError([NSString stringWithFormat:@"Timed out waiting for the encoder at frame %d", index]));
            }
            [NSThread sleepForTimeInterval:0.002];
        }
        CVPixelBufferRef buffer = ReadFrame(attributes, (size_t)width, (size_t)height, index, error);
        if (buffer == NULL) {
            return NO;
        }
        BOOL appended = [adaptor appendPixelBuffer:buffer withPresentationTime:CMTimeMake(index, fps)];
        CVPixelBufferRelease(buffer);
        if (!appended) {
            return Fail(error, writer.error ?: RenderError([NSString stringWithFormat:@"Failed to append frame %d", index]));
        }
    }
    [input markAsFinished];
    [writer endSessionAtSourceTime:CMTimeMake(frameCount, fps)];
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [writer finishWritingWithCompletionHandler:^{
        dispatch_semaphore_signal(done);
    }];
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(120 * NSEC_PER_SEC))) != 0) {
        [writer cancelWriting];
        return Fail(error, RenderError(@"Timed out finalizing the MP4"));
    }
    if (writer.status != AVAssetWriterStatusCompleted) {
        return Fail(error, writer.error ?: RenderError([NSString stringWithFormat:@"Writer finished with status %ld", (long)writer.status]));
    }
    return YES;
}

static BOOL ParseInt(const char *text, int *value) {
    char *end = NULL;
    errno = 0;
    long parsed = strtol(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || parsed < -2147483647L || parsed > 2147483647L) {
        return NO;
    }
    *value = (int)parsed;
    return YES;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 6) {
            fprintf(stderr, "render error: usage: render_mp4 OUTPUT WIDTH HEIGHT FPS FRAMES < raw BGRA frames on stdin\n");
            return 1;
        }
        int width = 0, height = 0, fps = 0, frames = 0;
        if (!ParseInt(argv[2], &width) || !ParseInt(argv[3], &height) || !ParseInt(argv[4], &fps) || !ParseInt(argv[5], &frames)) {
            fprintf(stderr, "render error: Invalid numeric argument\n");
            return 1;
        }
        if (width <= 0 || height <= 0 || width % 2 != 0 || height % 2 != 0) {
            fprintf(stderr, "render error: H.264 needs positive, even dimensions; got %dx%d\n", width, height);
            return 1;
        }
        if (fps < 1 || fps > 60 || frames < 1 || frames > fps * 60) {
            fprintf(stderr, "render error: Out-of-range fps (%d) or frame count (%d)\n", fps, frames);
            return 1;
        }
        NSString *output = [NSString stringWithUTF8String:argv[1]];
        NSError *error = nil;
        if (!Render(output, width, height, fps, frames, &error)) {
            fprintf(stderr, "render error: %s\n", Describe(error).UTF8String);
            return 1;
        }
        NSDictionary *payload = @{
            @"status": @"ok", @"output": output, @"width": @(width), @"height": @(height),
            @"fps": @(fps), @"duration": @((double)frames / (double)fps), @"frames": @(frames),
        };
        NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:NSJSONWritingSortedKeys error:&error];
        if (data == nil) {
            fprintf(stderr, "render error: %s\n", Describe(error).UTF8String);
            return 1;
        }
        printf("%s\n", [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    }
    return 0;
}
