#!/usr/bin/env python3
"""
Renders demo/explainer.mp4 - a code-drawn (not screen-recorded) animated
explainer of the prewarm mechanism, frame by frame with Pillow, encoded with
ffmpeg. No manual video editing; rerun this script to regenerate.

    python3 demo/render_explainer.py
"""
import math
import os
import shutil
import subprocess
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
FPS = 30
FRAMES_DIR = os.path.join(os.path.dirname(__file__), ".frames")
OUT_PATH = os.path.join(os.path.dirname(__file__), "explainer.mp4")

# Dracula-family palette, matching demo.gif for brand consistency.
BG = (40, 42, 54)
FG = (248, 248, 242)
COMMENT = (98, 114, 164)
PURPLE = (189, 147, 249)
PINK = (255, 121, 198)
RED = (255, 85, 85)
GREEN = (80, 250, 123)
YELLOW = (241, 250, 140)
CYAN = (139, 233, 253)
ORANGE = (255, 184, 108)

MONO = "/System/Library/Fonts/SFNSMono.ttf"
SANS = "/System/Library/Fonts/HelveticaNeue.ttc"

def font(path, size):
    return ImageFont.truetype(path, size)

F_TITLE = font(SANS, 92)
F_TAGLINE = font(SANS, 30)
F_HEADLINE = font(SANS, 36)
F_LABEL = font(MONO, 22)
F_LABEL_SM = font(MONO, 18)
F_COUNTER = font(MONO, 54)
F_TERM = font(MONO, 24)
F_CTA = font(MONO, 34)

def clamp01(t):
    return max(0.0, min(1.0, t))

def ease_out_cubic(t):
    t = clamp01(t)
    return 1 - (1 - t) ** 3

def ease_in_out(t):
    t = clamp01(t)
    return t * t * (3 - 2 * t)

def lerp(a, b, t):
    return a + (b - a) * clamp01(t)

def lerp_color(c1, c2, t):
    t = clamp01(t)
    return tuple(int(lerp(c1[i], c2[i], t)) for i in range(3))

def phase(t, start, end):
    """Local progress within [start,end] of scene-local t, clamped to [0,1]."""
    if end <= start:
        return 1.0 if t >= end else 0.0
    return clamp01((t - start) / (end - start))

def text_center(draw, xy, s, fnt, fill):
    bbox = draw.textbbox((0, 0), s, font=fnt)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((xy[0] - w / 2 - bbox[0], xy[1] - h / 2 - bbox[1]), s, font=fnt, fill=fill)

def text_left(draw, xy, s, fnt, fill):
    draw.text(xy, s, font=fnt, fill=fill)

AXIS_X0, AXIS_X1, AXIS_Y = 140, 1140, 430
HOUR_START, HOUR_END = 6.0, 16.5

def hour_to_x(hour):
    return AXIS_X0 + (hour - HOUR_START) / (HOUR_END - HOUR_START) * (AXIS_X1 - AXIS_X0)

def draw_axis(draw):
    draw.line([(AXIS_X0, AXIS_Y), (AXIS_X1, AXIS_Y)], fill=COMMENT, width=3)
    for h in range(6, 17):
        x = hour_to_x(h)
        draw.line([(x, AXIS_Y - 6), (x, AXIS_Y + 6)], fill=COMMENT, width=2)
        label = f"{h:02d}:00"
        text_center(draw, (x, AXIS_Y + 28), label, F_LABEL_SM, COMMENT)

def new_frame():
    img = Image.new("RGB", (W, H), BG)
    return img, ImageDraw.Draw(img)

def fadeable(draw_fn, alpha_t):
    """No true alpha layer; caller passes already-lerped color."""
    draw_fn()

# ---- Scene A: Title ----
def scene_title(t):
    img, d = new_frame()
    fade = ease_out_cubic(phase(t, 0.0, 0.45))
    scale_t = ease_out_cubic(phase(t, 0.0, 0.5))
    title_color = lerp_color(BG, FG, fade)
    title_y = H / 2 - 40
    # simple "scale" via font size interpolation (coarse but cheap and legible)
    size = int(lerp(70, 92, scale_t))
    f = font(SANS, size) if size != 92 else F_TITLE
    text_center(d, (W / 2, title_y), "spareloop", f, title_color)

    tag_fade = ease_out_cubic(phase(t, 0.35, 0.8))
    tag_color = lerp_color(BG, COMMENT, tag_fade)
    text_center(d, (W / 2, title_y + 90), "Stop wasting your AI coding subscription.", F_TAGLINE, tag_color)

    sub_fade = ease_out_cubic(phase(t, 0.55, 1.0))
    sub_color = lerp_color(BG, PURPLE, sub_fade)
    text_center(d, (W / 2, title_y + 140), "a real 270-minute daily dead zone, measured", F_LABEL, sub_color)
    return img

# ---- Scenes B & C share a timeline renderer ----
def draw_marker(d, x, y, color, radius=8, pulse=0.0):
    r = radius + pulse * 6
    d.ellipse([x - r, y - r, x + r, y + r], outline=color, width=3)
    d.ellipse([x - radius, y - radius, x + radius, y + radius], fill=color)

def scene_problem(t):
    img, d = new_frame()
    draw_axis(d)

    head_fade = ease_out_cubic(phase(t, 0.0, 0.18))
    head_color = lerp_color(BG, FG, head_fade)
    text_center(d, (W / 2, 120), "You're losing hours every day - and you don't see it happen.", F_HEADLINE, head_color)

    start_h, exh_h, reset_h = 9 + 47 / 60, 11 + 15 / 60, 15 + 45 / 60
    x_start, x_exh, x_reset = hour_to_x(start_h), hour_to_x(exh_h), hour_to_x(reset_h)

    # active-usage bar grows from start to exhaustion
    fill_t = ease_out_cubic(phase(t, 0.15, 0.5))
    bar_x1 = lerp(x_start, x_exh, fill_t)
    if fill_t > 0:
        d.rectangle([x_start, AXIS_Y - 14, bar_x1, AXIS_Y + 14], fill=PURPLE)

    start_label_fade = ease_out_cubic(phase(t, 0.15, 0.3))
    if start_label_fade > 0:
        draw_marker(d, x_start, AXIS_Y, lerp_color(BG, FG, start_label_fade))
        text_center(d, (x_start, AXIS_Y - 34), "09:47 start", F_LABEL_SM, lerp_color(BG, FG, start_label_fade))

    # limit-hit flash (label placed BELOW the axis - it sits close to the
    # start label horizontally, so stagger vertically to avoid text collision)
    flash_t = phase(t, 0.48, 0.58)
    if flash_t > 0:
        flash_alpha = math.sin(flash_t * math.pi)
        col = lerp_color(FG, RED, flash_alpha)
        draw_marker(d, x_exh, AXIS_Y, RED, pulse=flash_alpha)
        text_center(d, (x_exh, AXIS_Y + 44), "11:15 LIMIT HIT", F_LABEL, col)

    # dead zone grows
    dz_t = ease_out_cubic(phase(t, 0.5, 0.85))
    dz_x1 = lerp(x_exh, x_reset, dz_t)
    if dz_t > 0:
        overlay = Image.new("RGB", img.size, img.getpixel((0, 0)))
        od = ImageDraw.Draw(overlay)
        od.rectangle([x_exh, AXIS_Y - 20, dz_x1, AXIS_Y + 20], fill=lerp_color(BG, RED, 0.35))
        img = Image.blend(img, overlay, 1.0)
        d = ImageDraw.Draw(img)
        draw_axis(d)  # redraw axis over the shaded block's edges

    # counter
    counter_t = ease_out_cubic(phase(t, 0.5, 0.95))
    minutes = int(lerp(0, 270, counter_t))
    counter_color = lerp_color(BG, RED, ease_out_cubic(phase(t, 0.5, 0.65)))
    text_center(d, (W / 2, 580), f"{minutes} min wasted today", F_COUNTER, counter_color)

    # reset marker
    reset_fade = ease_out_cubic(phase(t, 0.85, 1.0))
    if reset_fade > 0:
        draw_marker(d, x_reset, AXIS_Y, lerp_color(BG, GREEN, reset_fade))
        text_center(d, (x_reset, AXIS_Y - 34), "15:45 reset", F_LABEL_SM, lerp_color(BG, GREEN, reset_fade))
    return img

def scene_solution(t):
    img, d = new_frame()
    draw_axis(d)

    head_fade = ease_out_cubic(phase(t, 0.0, 0.18))
    head_color = lerp_color(BG, FG, head_fade)
    text_center(d, (W / 2, 120), "spareloop learns the pattern and fires one tiny prompt earlier.", F_HEADLINE, head_color)

    prewarm_h, start_h, exh_h, shifted_reset_h = 6 + 10 / 60, 9 + 47 / 60, 11 + 15 / 60, 11 + 10 / 60
    x_pre, x_start, x_exh, x_sreset = (
        hour_to_x(prewarm_h), hour_to_x(start_h), hour_to_x(exh_h), hour_to_x(shifted_reset_h)
    )

    # prewarm ping
    pre_t = ease_out_cubic(phase(t, 0.12, 0.28))
    if pre_t > 0:
        pulse = 0.5 + 0.5 * math.sin(t * 14)
        draw_marker(d, x_pre, AXIS_Y, lerp_color(BG, CYAN, pre_t), pulse=pulse * pre_t)
        text_center(d, (x_pre, AXIS_Y - 34), "06:10 prewarm ping", F_LABEL_SM, lerp_color(BG, CYAN, pre_t))
        thin_t = ease_out_cubic(phase(t, 0.2, 0.35))
        if thin_t > 0:
            d.rectangle([x_pre, AXIS_Y - 5, lerp(x_pre, x_start, thin_t), AXIS_Y + 5], fill=lerp_color(BG, CYAN, thin_t))

    # real usage bar, start -> exhaustion point (drawn in full since no lockout occurs)
    fill_t = ease_out_cubic(phase(t, 0.32, 0.6))
    bar_x1 = lerp(x_start, x_exh, fill_t)
    if fill_t > 0:
        d.rectangle([x_start, AXIS_Y - 14, bar_x1, AXIS_Y + 14], fill=PURPLE)
        draw_marker(d, x_start, AXIS_Y, lerp_color(BG, FG, min(1, fill_t * 3)))
        text_center(d, (x_start, AXIS_Y - 34), "09:47 continues", F_LABEL_SM, lerp_color(BG, FG, min(1, fill_t * 3)))

    # shifted reset marker - fires BEFORE natural exhaustion, no red anywhere.
    # Label placed BELOW the axis: it sits close to the start label
    # horizontally, so stagger vertically to avoid text collision.
    sreset_t = ease_out_cubic(phase(t, 0.5, 0.68))
    if sreset_t > 0:
        pulse = 0.5 + 0.5 * math.sin(t * 10)
        draw_marker(d, x_sreset, AXIS_Y, lerp_color(BG, GREEN, sreset_t), pulse=pulse * sreset_t)
        text_center(d, (x_sreset, AXIS_Y + 44), "11:10 reset (fresh)", F_LABEL, lerp_color(BG, GREEN, sreset_t))

    # continue bar seamlessly through the old exhaustion point, no interruption
    cont_t = ease_out_cubic(phase(t, 0.62, 0.85))
    if cont_t > 0:
        cont_x1 = lerp(x_exh, hour_to_x(13.0), cont_t)
        d.rectangle([x_exh, AXIS_Y - 14, cont_x1, AXIS_Y + 14], fill=lerp_color(PURPLE, GREEN, 0.15))

    # counter: strike old number, show new
    old_fade = ease_out_cubic(phase(t, 0.55, 0.7))
    if old_fade > 0:
        col = lerp_color(BG, COMMENT, old_fade)
        text_center(d, (W / 2, 560), "270 min wasted", F_COUNTER, col)
        bbox = d.textbbox((0, 0), "270 min wasted", font=F_COUNTER)
        tw = bbox[2] - bbox[0]
        strike_t = ease_out_cubic(phase(t, 0.6, 0.72))
        if strike_t > 0:
            sx = lerp(W / 2 - tw / 2, W / 2 + tw / 2, strike_t)
            d.line([(W / 2 - tw / 2, 560), (sx, 560)], fill=RED, width=4)

    new_fade = ease_out_cubic(phase(t, 0.72, 0.95))
    if new_fade > 0:
        text_center(d, (W / 2, 630), "~0 min wasted", F_COUNTER, lerp_color(BG, GREEN, new_fade))
    return img

# ---- Scene D: terminal snippet ----
TERM_LINES = [
    ("$ spareloop suggest", FG),
    ("", FG),
    ("Claude Code - usage pattern (21-day lookback, 18 days with limit hits)", COMMENT),
    ("  Typical exhaustion: 11:15   Window reset: 15:45   Dead zone: ~270 min", FG),
    ("", FG),
    ("  [enable_prewarm] Prewarm at 06:10 shifts your window reset to ~11:10,", GREEN),
    ("  landing just before you'd normally hit the wall.", GREEN),
]

def scene_terminal(t):
    img, d = new_frame()
    box = (140, 140, 1140, 580)
    d.rounded_rectangle(box, radius=18, fill=(30, 31, 41), outline=COMMENT, width=2)
    d.ellipse([box[0] + 20, box[1] + 18, box[0] + 36, box[1] + 34], fill=RED)
    d.ellipse([box[0] + 46, box[1] + 18, box[0] + 62, box[1] + 34], fill=YELLOW)
    d.ellipse([box[0] + 72, box[1] + 18, box[0] + 88, box[1] + 34], fill=GREEN)

    total_chars = sum(len(l) for l, _ in TERM_LINES)
    reveal_t = ease_out_cubic(phase(t, 0.05, 0.85))
    budget = int(total_chars * reveal_t)

    y = box[1] + 60
    remaining = budget
    for line, color in TERM_LINES:
        take = max(0, min(len(line), remaining))
        remaining -= take
        text_left(d, (box[0] + 30, y), line[:take], F_TERM, color)
        y += 34

    cursor_on = int(t * 4) % 2 == 0
    if reveal_t < 1.0 and cursor_on:
        d.rectangle([box[0] + 30, y, box[0] + 42, y + 24], fill=FG)
    return img

# ---- Scene E: CTA ----
def scene_cta(t):
    img, d = new_frame()
    fade = ease_out_cubic(phase(t, 0.0, 0.3))
    text_center(d, (W / 2, 260), "spareloop", font(SANS, 80), lerp_color(BG, FG, fade))

    cmd_fade = ease_out_cubic(phase(t, 0.2, 0.5))
    if cmd_fade > 0:
        box_w = 560
        box = (W / 2 - box_w / 2, 350, W / 2 + box_w / 2, 410)
        d.rounded_rectangle(box, radius=10, outline=lerp_color(BG, COMMENT, cmd_fade), width=2)
        text_center(d, (W / 2, 380), "npm install -g spareloop", F_CTA, lerp_color(BG, GREEN, cmd_fade))

    url_fade = ease_out_cubic(phase(t, 0.4, 0.7))
    text_center(d, (W / 2, 460), "github.com/VinayJogani14/spareloop", F_LABEL, lerp_color(BG, CYAN, url_fade))

    star_fade = ease_out_cubic(phase(t, 0.55, 0.85))
    pulse = 1.0 + 0.08 * math.sin(t * 8)
    if star_fade > 0:
        f = font(SANS, int(34 * pulse))
        text_center(d, (W / 2, 540), "* Star it if this saves you time", f, lerp_color(BG, ORANGE, star_fade))

    fade_out = ease_out_cubic(phase(t, 0.92, 1.0))
    if fade_out > 0:
        overlay = Image.new("RGB", img.size, BG)
        img = Image.blend(img, overlay, fade_out)
    return img

SCENES = [
    (scene_title, 2.5),
    (scene_problem, 7.0),
    (scene_solution, 7.0),
    (scene_terminal, 5.0),
    (scene_cta, 3.5),
]

def render():
    if os.path.exists(FRAMES_DIR):
        shutil.rmtree(FRAMES_DIR)
    os.makedirs(FRAMES_DIR)

    frame_idx = 0
    for scene_fn, duration in SCENES:
        n_frames = int(duration * FPS)
        for i in range(n_frames):
            local_t = i / max(1, n_frames - 1)
            img = scene_fn(local_t)
            img.save(os.path.join(FRAMES_DIR, f"f{frame_idx:05d}.png"))
            frame_idx += 1
    print(f"Rendered {frame_idx} frames to {FRAMES_DIR}")

    subprocess.run(
        [
            "ffmpeg", "-y", "-framerate", str(FPS),
            "-i", os.path.join(FRAMES_DIR, "f%05d.png"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
            OUT_PATH,
        ],
        check=True,
    )
    shutil.rmtree(FRAMES_DIR)
    print(f"Wrote {OUT_PATH}")

if __name__ == "__main__":
    render()
