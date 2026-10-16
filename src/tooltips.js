// Accessible tooltips for extension pages. An element with data-tooltip shows
// its text on mouse hover, keyboard focus, and touch. The same text is exposed
// to assistive technology through aria-describedby on the focusable control,
// so the tooltip never replaces a visible label or accessible name.

const tooltipFocusableSelector =
  "button, a[href], input, select, textarea, summary, [tabindex]";
const tooltipHoverDelay = 350;
const tooltipTouchDuration = 2500;
let tooltipElement;
let tooltipDescriptions;
let tooltipTrigger = null;
let tooltipShowTimer;
let tooltipHideTimer;
let tooltipSequence = 0;

function getTooltipElement() {
  if (!tooltipElement) {
    tooltipElement = document.createElement("div");
    tooltipElement.id = "vap-tooltip";
    tooltipElement.className = "tooltip";
    tooltipElement.setAttribute("role", "tooltip");
    tooltipElement.hidden = true;
    tooltipElement.addEventListener("pointerenter", () =>
      clearTimeout(tooltipHideTimer),
    );
    tooltipElement.addEventListener("pointerleave", () =>
      scheduleTooltipHide(),
    );
    document.body.append(tooltipElement);
  }
  return tooltipElement;
}

function getDescribedElement(trigger) {
  return trigger.matches(tooltipFocusableSelector)
    ? trigger
    : (trigger.querySelector(tooltipFocusableSelector) ?? trigger);
}

function setTooltip(trigger, text) {
  if (!trigger) {
    return;
  }
  trigger.dataset.tooltip = text;
  trigger.removeAttribute("title");
  tooltipDescriptions ??= document.body.appendChild(
    Object.assign(document.createElement("div"), {
      className: "sr-only",
      id: "vap-tooltip-descriptions",
    }),
  );
  let description = trigger.dataset.tooltipDescriptionId
    ? document.getElementById(trigger.dataset.tooltipDescriptionId)
    : null;
  if (!description) {
    description = document.createElement("span");
    description.id = `vap-tooltip-description-${++tooltipSequence}`;
    tooltipDescriptions.append(description);
    trigger.dataset.tooltipDescriptionId = description.id;
    const described = getDescribedElement(trigger);
    const ids = new Set(
      (described.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter(Boolean),
    );
    ids.add(description.id);
    described.setAttribute("aria-describedby", [...ids].join(" "));
  }
  description.textContent = text;
  if (tooltipTrigger === trigger && !getTooltipElement().hidden) {
    tooltipElement.textContent = text;
    positionTooltip(trigger);
  }
}

function initTooltips(root = document) {
  const api = globalThis.chrome?.i18n ? globalThis.chrome : globalThis.browser;
  for (const trigger of root.querySelectorAll("[data-i18n-tooltip]")) {
    const text = api?.i18n?.getMessage(trigger.dataset.i18nTooltip);
    if (text) {
      setTooltip(trigger, text);
    }
  }
}

function positionTooltip(trigger) {
  const margin = 8;
  const gap = 6;
  const tooltip = getTooltipElement();
  tooltip.style.maxWidth = `${Math.min(280, window.innerWidth - margin * 2)}px`;
  tooltip.style.left = "0px";
  tooltip.style.top = "0px";
  const anchor = trigger.getBoundingClientRect();
  const { width, height } = tooltip.getBoundingClientRect();
  let top = anchor.bottom + gap;
  let placement = "below";
  if (top + height > window.innerHeight - margin && anchor.top - gap > height) {
    top = anchor.top - gap - height;
    placement = "above";
  }
  const left = Math.min(
    Math.max(margin, anchor.left + anchor.width / 2 - width / 2),
    Math.max(margin, window.innerWidth - width - margin),
  );
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(Math.max(margin, top))}px`;
  tooltip.dataset.placement = placement;
}

function showTooltip(trigger, delay = 0) {
  clearTimeout(tooltipShowTimer);
  clearTimeout(tooltipHideTimer);
  tooltipShowTimer = setTimeout(() => {
    if (!trigger.isConnected || !trigger.dataset.tooltip) {
      return;
    }
    const tooltip = getTooltipElement();
    tooltipTrigger = trigger;
    tooltip.textContent = trigger.dataset.tooltip;
    tooltip.hidden = false;
    positionTooltip(trigger);
  }, delay);
}

function hideTooltip() {
  clearTimeout(tooltipShowTimer);
  clearTimeout(tooltipHideTimer);
  tooltipTrigger = null;
  if (tooltipElement) {
    tooltipElement.hidden = true;
  }
}

function scheduleTooltipHide(delay = 150) {
  clearTimeout(tooltipShowTimer);
  clearTimeout(tooltipHideTimer);
  tooltipHideTimer = setTimeout(hideTooltip, delay);
}

document.addEventListener("pointerover", (event) => {
  const trigger = event.target.closest?.("[data-tooltip]");
  if (!trigger) {
    return;
  }
  if (event.pointerType === "mouse") {
    if (trigger !== tooltipTrigger) {
      showTooltip(trigger, tooltipHoverDelay);
    } else {
      clearTimeout(tooltipHideTimer);
    }
  } else {
    showTooltip(trigger);
    tooltipHideTimer = setTimeout(hideTooltip, tooltipTouchDuration);
  }
});

document.addEventListener("pointerout", (event) => {
  const trigger = event.target.closest?.("[data-tooltip]");
  if (
    event.pointerType === "mouse" &&
    trigger &&
    !trigger.contains(event.relatedTarget)
  ) {
    scheduleTooltipHide();
  }
});

document.addEventListener("focusin", (event) => {
  const trigger = event.target.closest?.("[data-tooltip]");
  if (trigger && event.target.matches(":focus-visible")) {
    showTooltip(trigger);
  }
});

document.addEventListener("focusout", (event) => {
  if (event.target.closest?.("[data-tooltip]")) {
    hideTooltip();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && tooltipTrigger) {
    hideTooltip();
  }
});

// Follow the trigger when it scrolls (for example into view on keyboard
// focus) and hide the tooltip once the trigger leaves the viewport.
window.addEventListener(
  "scroll",
  () => {
    if (!tooltipTrigger) {
      return;
    }
    const { bottom, top } = tooltipTrigger.getBoundingClientRect();
    if (bottom < 0 || top > window.innerHeight) {
      hideTooltip();
    } else {
      positionTooltip(tooltipTrigger);
    }
  },
  { capture: true, passive: true },
);
window.addEventListener("resize", hideTooltip);
