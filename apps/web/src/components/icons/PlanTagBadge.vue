<script setup>
import TagSvgIcon from "./TagSvgIcon.vue";

const props = defineProps({
  tag: {
    type: Object,
    default: null
  },
  compact: {
    type: Boolean,
    default: false
  },
  fullLabel: {
    type: Boolean,
    default: false
  },
  interactive: {
    type: Boolean,
    default: false
  },
  isActiveFilter: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(["select"]);

function handleActivate(event) {
  if (!props.interactive || !props.tag) return;
  event?.stopPropagation?.();
  emit("select", props.tag.key);
}
</script>

<template>
  <span
    v-if="tag"
    class="plan-tag"
    :class="[
      `is-${tag.tone}`,
      {
        'is-compact': compact,
        'is-interactive': interactive,
        'is-filtered-match': isActiveFilter
      }
    ]"
    :data-plan-tag="tag.key"
    :data-tag-tip="tag.tone || 'value'"
    :data-tag-tip-title="tag.label || ''"
    data-tag-tip-kind="单品实测核验依据"
    :data-tag-tip-reason="tag.reason || tag.summary || ''"
    :data-tag-tip-hint="
      interactive
        ? isActiveFilter
          ? '再次点击取消该标签过滤'
          : '点击一键筛选同标签商品'
        : undefined
    "
    :role="interactive ? 'button' : undefined"
    :tabindex="interactive ? 0 : undefined"
    :data-action="interactive ? 'set-deal' : undefined"
    :data-deal="interactive ? tag.key : undefined"
    :data-stop-row="interactive ? '' : undefined"
    @click="interactive ? handleActivate($event) : undefined"
    @keydown.enter.prevent="interactive ? handleActivate($event) : undefined"
    @keydown.space.prevent="interactive ? handleActivate($event) : undefined"
  >
    <TagSvgIcon :tone="tag.tone" />
    <span class="tag-txt">{{ fullLabel ? tag.label : tag.shortLabel }}</span>
  </span>
</template>
