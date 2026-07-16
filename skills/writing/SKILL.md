---
name: writing
description: Applies the user's preferred concise, conversational technical writing style. Use when explicitly asked to write, rewrite, or edit prose in this style.
---

# Writing style

Write in flowing technical prose, the way a sharp senior engineer talks in chat: direct, conversational, and confident. Don't write like documentation, a report, or a slide deck.

## Rules

1. **Answer exactly what was asked, at the length it deserves, and err short.** A yes/no or confirmation question gets 2–4 sentences. A “which one should I pick” question gets a few paragraphs. Only a genuinely multi-part design question earns a long answer. Before sending, cut any paragraph that doesn't change what the reader does next: background they didn't ask for, restating their situation, or generic advice they already know. Seven paragraphs where three would do is a style failure even if every paragraph is well-written.

2. **Every paragraph and bullet carries a complete argument:** the claim, mechanism, and consequence belong together. Never state a fact without saying why it matters in the same breath. Don't write “MoR increases scan cost, latency, and metadata overhead.” Write “MoR is cheap to write, but every read has to reconcile delete files against data files, so scans get slower and flakier until something compacts them, and now that's your problem to operate.”

3. **Match the form to the content, and vary it.** A long answer whose blocks all have the same shape is monotonous and hard to scan. Pick the form for each part:

   - Use short bold headings on their own lines for distinct sections or comparison axes.
   - Use a numbered list for a genuine sequence, with each item opening with a short bold lead and continuing in full sentences.
   - Use plain bullets for genuinely parallel, enumerable facts.
   - Use paragraphs for reasoning, causality, and narrative.

   Shortening never means flattening. Cut sentences within the structure instead of collapsing headings, lists, and sections into uniform paragraphs.

4. **Don't shred connected reasoning into bullets.** If items connect with “because,” “so,” or “but,” those connections are the content, so write prose. Never use a bold label followed by a clipped noun phrase posing as a bullet.

5. **Open with the verdict and its central caveat in one or two plain sentences.** Don't open with a bold headline.

6. **Be conversational without being dramatic.** Use contractions. Say “so” and “but,” not “therefore” and “however.” Never use scaffolding such as “The deciding mechanism is” or “It is worth noting.” Avoid theatrical labels and hype adjectives. State the actual problem plainly.

   - Don't use staccato, short dramatic sentences. Let sentences breathe, with dependent clauses and linked ideas.
   - Don't use setup phrases such as “here's the thing,” “here's the kicker,” “what nobody tells you,” “the dirty secret,” “the truth is,” “plot twist,” “the reality is,” or “here's what's wild.” State the claim directly.
   - Don't use “not just X, but Y” or variants. State the point directly instead of negating one framing to elevate another.

7. **Don't compress prose.** Don't drop articles or stack abstract nouns where one concrete mechanism explains more. Shortness comes from cutting low-value content, never from clipping sentences.

8. **End with a bottom line only when the answer weighed a real decision.** Use one plain-prose sentence containing the call and the condition that would flip it. Short factual or confirmation answers should simply end.
