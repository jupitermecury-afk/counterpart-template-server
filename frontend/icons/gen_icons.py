from PIL import Image, ImageDraw, ImageChops
import os

SIZE = 1024
NAVY = (10, 37, 64, 255)        # #0a2540
CORNFLOWER = (99, 91, 255, 255) # #635bff
WHITE = (255, 255, 255, 255)

out_dir = os.path.dirname(os.path.abspath(__file__))

base = Image.new("RGB", (SIZE, SIZE), NAVY[:3])
draw = ImageDraw.Draw(base)

# Outer badge circle: cornflower blue, centered, within maskable safe zone
cx, cy = SIZE // 2, SIZE // 2
r = 360
draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=CORNFLOWER[:3])

# Vesica/"flame" mark: intersection of two offset circles, in white
mask_a = Image.new("L", (SIZE, SIZE), 0)
mask_b = Image.new("L", (SIZE, SIZE), 0)
lr = 250
ImageDraw.Draw(mask_a).ellipse([cx - lr, cy - lr - 130, cx + lr, cy + lr - 130], fill=255)
ImageDraw.Draw(mask_b).ellipse([cx - lr, cy - lr + 130, cx + lr, cy + lr + 130], fill=255)
lens_mask = ImageChops.darker(mask_a, mask_b)

white_layer = Image.new("RGB", (SIZE, SIZE), WHITE[:3])
base.paste(white_layer, (0, 0), lens_mask)

base.resize((512, 512), Image.LANCZOS).save(os.path.join(out_dir, "icon-512.png"))
base.resize((512, 512), Image.LANCZOS).save(os.path.join(out_dir, "icon-512-maskable.png"))
base.resize((192, 192), Image.LANCZOS).save(os.path.join(out_dir, "icon-192.png"))
base.resize((180, 180), Image.LANCZOS).save(os.path.join(out_dir, "apple-touch-icon.png"))
base.resize((32, 32), Image.LANCZOS).save(os.path.join(out_dir, "favicon-32.png"))

print("done")
