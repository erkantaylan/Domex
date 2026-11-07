---
name: announce
description: Write a Discord announcement for a Teacher's Garden lesson, either the "before class" post with the start time or the "class starts" post, in the same vague, themed style as the earlier ones, and save it to docs/announcements/. Use when the teacher says "announcement", "announce the lesson", "lesson start announcement", or runs /announce.
---

# Lesson announcements

The teacher posts these in the class Discord. Write the text, save it, and show it in a code block so the teacher can copy it. Never post it anywhere yourself.

## First: read the earlier ones

Read every file in `docs/announcements/` before writing. The new post should feel like part of the same series, and it shouldn't repeat their lines.

## The two kinds

**Before class:** posted a while ahead. It carries the start time.

- Opens with `@Programming <t:UNIX:F> (<t:UNIX:R>)`.
- A bold title: `**The Teacher's Garden: <name of the night>**`, with a matching emoji on each side.
- Three or four short lines that tease without telling. One of them says the students decide what happens.
- The start line again with both timestamps, then `**Lasts:** about 2 hours`.
- A short closing line with two emojis.

**Class starts:** posted when the lesson begins.

- Opens with `@Programming` and a bold "we're open" title.
- One teasing line about where the bot is now.
- Join the voice channel, and keep the survey page open. Write the survey link as `<survey link>`: the tunnel address changes every lesson, and the teacher swaps it in.
- A short closing line.

## Style

- **Stay vague.** Never name the project, the features, the tools or the stack, and never say what will be built. "Something woke up in the garden" yes; "we add easy mode with buttons" no.
- Keep the garden theme (the class is The Teacher's Garden). Take a seasonal theme only when it fits the date, as Halloween did for lesson 1.
- Use Discord emoji shortcodes (`:seedling:`), not Unicode emojis.
- Short lines, one idea each. About 8 to 12 lines in total.

## Times

Discord shows `<t:UNIX:F>` as the full date and time in each reader's own time zone, and `<t:UNIX:R>` as "in 45 minutes". Work out the Unix time with `date`, never by hand:

```sh
date -d "2026-11-14 19:00" +%s
```

Lessons have been on Saturdays at 19:00 local time. Ask the teacher if the time isn't clear.

## Save it

Each lesson has one file, `docs/announcements/lesson-NN.md`, with the date and Unix time at the top and one section per kind (`## Before class`, `## Class starts`). Add the new post to the right file, or start the file if it's a new lesson. Put each post in a fenced code block, exactly as it should be posted.

Commit the file once the teacher is happy with the text.
