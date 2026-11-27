<script setup>
import { computed, nextTick, ref } from "vue";
import { ElOption, ElSelect } from "element-plus";

defineOptions({
  inheritAttrs: false
});

const props = defineProps({
  modelValue: {
    type: [String, Number],
    default: ""
  },
  options: {
    type: Array,
    default: () => []
  },
  placeholder: {
    type: String,
    default: "请选择"
  },
  ariaLabel: {
    type: String,
    default: ""
  },
  filterable: {
    type: Boolean,
    default: false
  },
  filtered: {
    type: Boolean,
    default: false
  },
  variant: {
    type: String,
    default: "mini" // "region" | "mini" | "budget" | "sort" | "full"
  },
  disabled: {
    type: Boolean,
    default: false
  },
  teleported: {
    type: Boolean,
    default: true
  },
  size: {
    type: String,
    default: "small"
  }
});

const emit = defineEmits(["update:modelValue", "change"]);

const selectRef = ref(null);
let composingTarget = null;
const variantClass = computed(() => `is-${props.variant}`);

function resetMountedOptionVisibility() {
  const select = selectRef.value;
  if (!select) return;
  select.optionsArray?.forEach?.((opt) => opt.updateOption?.(""));
}

function handleChange(val) {
  resetMountedOptionVisibility();
  emit("update:modelValue", val);
  emit("change", val);
}

function handleVisibleChange(visible) {
  if (!visible) {
    resetMountedOptionVisibility();
    return;
  }
  const select = selectRef.value;
  if (select?.states) {
    select.states.isBeforeHide = false;
  }
  void nextTick().then(() => {
    const s = selectRef.value;
    if (s?.states) {
      s.states.isBeforeHide = false;
      if (!s.states.inputValue) {
        s.updateOptions?.();
      }
      if (s.states.hoveringIndex < 0 && Array.isArray(s.optionsArray)) {
        const selectedIdx = s.optionsArray.findIndex(
          (opt) => opt.value === props.modelValue && opt.visible !== false && !opt.isDisabled
        );
        if (selectedIdx >= 0) {
          s.states.hoveringIndex = selectedIdx;
        }
      }
    }
    const active = globalThis.document?.activeElement;
    const root = s?.$el;
    if (root && active && root.contains(active) && active.getAttribute?.("role") !== "combobox") {
      s?.focus?.();
    }
  });
}

function isActiveSelectComposition(event) {
  if (event?.isComposing || event?.key === "Process" || event?.keyCode === 229) {
    return true;
  }
  if (!composingTarget) return false;
  if (!composingTarget.isConnected || (event?.target && event.target !== composingTarget)) {
    composingTarget = null;
    return false;
  }
  return event?.target === composingTarget;
}

function handleKeydownCapture(event) {
  if (isActiveSelectComposition(event)) {
    // Stop ElSelect from intercepting IME candidate navigation (Arrow/Page), Escape, or Enter while keeping native IME behavior
    event.stopPropagation();
    return;
  }
  if (event.key === "Escape" || event.code === "Escape") {
    const select = selectRef.value;
    const combobox = select?.$el?.querySelector?.("[role='combobox']");
    const isExpanded =
      Boolean(select?.dropdownMenuVisible) ||
      combobox?.getAttribute?.("aria-expanded") === "true";
    if (isExpanded) {
      event.preventDefault();
      event.stopPropagation();
      if (select?.states) {
        select.states.inputValue = "";
        select.states.visible = false;
      }
      select?.handleEsc?.();
      resetMountedOptionVisibility();
      select?.focus?.();
      return;
    }
    // Collapsed ElSelect must not swallow Escape via its internal @keydown.esc.stop.prevent:
    // stop ElSelect's inner handler and pass Escape synchronously to App's unified dismiss chain.
    event.stopPropagation();
    globalThis.document?.dispatchEvent?.(
      new CustomEvent("resnode:escape-passthrough", {
        detail: { target: event.target || combobox || null }
      })
    );
    return;
  }
  const isSpaceKey = event.key === " " || event.key === "Spacebar" || event.code === "Space";
  if (isSpaceKey && !props.filterable) {
    event.preventDefault();
    event.stopPropagation();
    const select = selectRef.value;
    if (!select) return;
    const combobox = select.$el?.querySelector?.("[role='combobox']");
    const isExpanded =
      Boolean(select.dropdownMenuVisible) ||
      combobox?.getAttribute?.("aria-expanded") === "true";
    if (!isExpanded) {
      if (typeof select.toggleMenu === "function") {
        select.toggleMenu();
      } else if (select.states) {
        select.states.visible = true;
      }
      return;
    }
    const hoverIdx = select.states?.hoveringIndex ?? -1;
    const hoveredOption =
      hoverIdx >= 0 && Array.isArray(select.optionsArray)
        ? select.optionsArray[hoverIdx]
        : null;
    if (hoveredOption) {
      if (hoveredOption.visible !== false && !hoveredOption.isDisabled) {
        select.handleOptionSelect?.(hoveredOption);
      }
      return;
    }
    const firstVisible = select.optionsArray?.find?.(
      (opt) => opt.visible !== false && !opt.isDisabled
    );
    if (firstVisible) {
      select.handleOptionSelect?.(firstVisible);
    }
    return;
  }
  const isEnterKey =
    event.key === "Enter" ||
    event.code === "Enter" ||
    event.code === "NumpadEnter";
  if (!isEnterKey) return;
  const select = selectRef.value;
  if (!select?.dropdownMenuVisible) return;
  const count = select.filteredOptionsCount;
  if (count === 0) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const hovered = select.hoverOption;
  if (!hovered || hovered.visible === false || hovered.isDisabled) {
    event.preventDefault();
    event.stopPropagation();
    if (props.filterable) {
      const firstVisible = select.optionsArray?.find?.((opt) => opt.visible && !opt.isDisabled);
      if (firstVisible) {
        select.handleOptionSelect?.(firstVisible);
      }
    }
  }
}

function handleKeydown(event) {
  if (event.key !== "Escape") return;
  if (event.target?.getAttribute?.("role") === "combobox") return;
  const combobox = selectRef.value?.$el?.querySelector?.("[role='combobox']");
  if (combobox?.getAttribute?.("aria-expanded") === "true") {
    event.preventDefault();
    event.stopPropagation();
    selectRef.value?.handleEsc?.();
    selectRef.value?.focus?.();
  }
}
</script>

<template>
  <ElSelect
    ref="selectRef"
    v-bind="$attrs"
    class="radar-select"
    :class="[variantClass, { 'is-filtered': filtered }]"
    :model-value="modelValue"
    :placeholder="placeholder"
    :aria-label="ariaLabel"
    :filterable="filterable"
    :default-first-option="filterable"
    :disabled="disabled"
    :size="size"
    :teleported="teleported"
    :persistent="false"
    popper-class="radar-select-popper"
    @update:model-value="handleChange"
    @visible-change="handleVisibleChange"
    @compositionstart.capture="composingTarget = $event.target || null"
    @compositionend.capture="composingTarget = null"
    @keydown.capture="handleKeydownCapture"
    @keydown="handleKeydown"
  >
    <ElOption
      v-for="opt in options"
      :key="opt.value"
      :label="opt.label"
      :value="opt.value"
      :disabled="Boolean(opt.disabled)"
    >
      <span class="radar-option-row">
        <span class="radar-option-lead">
          <span v-if="opt.code" class="radar-option-code">{{ opt.code }}</span>
          <span>{{ opt.text ?? opt.label }}</span>
        </span>
        <span v-if="opt.count !== undefined && opt.count !== null" class="radar-option-count">
          {{ opt.count }}
        </span>
      </span>
    </ElOption>
  </ElSelect>
</template>
