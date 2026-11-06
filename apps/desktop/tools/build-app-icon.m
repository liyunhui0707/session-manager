#import <AppKit/AppKit.h>

// The same green wave mark as the reader shell, drawn at every native icon size.
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) return 2;
    NSString *output = [NSString stringWithUTF8String:argv[1]];
    for (NSNumber *sizeValue in @[@16, @32, @128, @256, @512]) {
      NSInteger size = sizeValue.integerValue;
      for (NSInteger scale = 1; scale <= 2; scale++) {
        NSInteger pixels = size * scale;
        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
          pixelsWide:pixels pixelsHigh:pixels bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES
          isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
        if (!bitmap) return 3;
        [NSGraphicsContext saveGraphicsState];
        NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
        NSAffineTransform *transform = [NSAffineTransform transform];
        [transform scaleBy:pixels / 1024.0]; [transform concat];
        [[NSColor colorWithCalibratedRed:.208 green:.388 blue:.310 alpha:1] setFill];
        [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(90,90,844,844) xRadius:190 yRadius:190] fill];
        [[NSColor colorWithCalibratedRed:.96 green:.98 blue:.95 alpha:1] setStroke];
        for (CGFloat y = 390; y <= 630; y += 120) {
          NSBezierPath *wave = [NSBezierPath bezierPath]; wave.lineWidth = 49; wave.lineCapStyle = NSLineCapStyleRound;
          [wave moveToPoint:NSMakePoint(290,y)];
          [wave curveToPoint:NSMakePoint(512,y) controlPoint1:NSMakePoint(360,y+85) controlPoint2:NSMakePoint(430,y+15)];
          [wave curveToPoint:NSMakePoint(734,y) controlPoint1:NSMakePoint(590,y-20) controlPoint2:NSMakePoint(660,y-75)];
          [wave stroke];
        }
        [NSGraphicsContext restoreGraphicsState];
        NSString *name = [NSString stringWithFormat:@"icon_%ldx%ld%@.png", (long)size, (long)size, scale == 2 ? @"@2x" : @""];
        NSData *data = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (![data writeToFile:[output stringByAppendingPathComponent:name] atomically:YES]) return 4;
      }
    }
  }
  return 0;
}
