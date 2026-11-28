# UI pattern sources

[UI Style Guides archive](https://aresluna.org/ui-style-guides/) preserves dated guides and mirrors across desktop and mobile platforms. Use the edition that fits the question. Prefer links and a short description of the applicable principle when documenting a decision.

| Problem | Start with | Review question |
|---|---|---|
| Desktop menus, shortcuts, grouping | [Motif and CDE 2.1, 1997](https://aresluna.org/ui-style-guides/OSF%20Motif%20and%20CDE/Motif%20and%20CDE%202.1%20Style%20Guide%20%281997%29/toc.htm), chapters 5 and 8. For a current Windows app use [Windows design basics](https://learn.microsoft.com/en-us/windows/apps/design/). | Can users discover the main command and repeat it with the keyboard? Are related actions grouped as they are elsewhere in the product? |
| Action hierarchy and touch controls | [Apple HIG: Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) and [Android design](https://developer.android.com/design). | Is the next action clear and operable with the intended input method? |
| Background work, quotas and warnings | [Windows progress controls](https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/progress-controls) and [WCAG 2.2: Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html). | Can the user distinguish waiting, completion, error, and a measured value through labels as well as color? |
| Web keyboard access and narrow screens | [WCAG 2.2: Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html) and [Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html). | Is focus apparent throughout the flow? Are labels and actions available on the smallest supported layout? |

## Quota dashboard example

When users choose an account by comparing quotas, show each decision-critical window in the account card. A row can show the window name, remaining percentage, and reset time. Show unavailable data explicitly. Place optional billing and model breakdowns in the details view. Verify that the rows remain readable on a narrow screen, under keyboard navigation, and without relying on the meaning of each color.
