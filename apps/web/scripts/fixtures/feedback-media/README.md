# Synthetic feedback media

These files contain generated colored rectangles only, no desktop, camera, microphone, mail, or user data. The PNG is 240×140 RGB with valid PNG chunks/CRC. MP4 (H.264) and WebM (VP8) are 240×140, 12 fps, one second, and have no audio stream. They are committed so CI does not need ffmpeg.

Videos were generated with a lavfi color source and a drawbox filter. Browser capture tests independently create a canvas MediaStream; getDisplayMedia is replaced before app code runs and never accesses the actual desktop.
