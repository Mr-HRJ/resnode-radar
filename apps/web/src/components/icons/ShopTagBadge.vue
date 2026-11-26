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
  interactive: {
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
    class="shop-tag"
    :class="[
      `is-${tag.tone}`,
      { 'is-compact': compact, 'is-interactive': interactive }
    ]"
    :data-shop-tag="tag.key"
    :data-tag-tip="tag.tone || 'value'"
    :data-tag-tip-title="tag.label || ''"
    :data-tag-tip-kind="tag.basis === 'editorial' ? '店铺定位核验' : '店铺实时现货核验'"
    :data-tag-tip-reason="tag.reason || tag.summary || ''"
    :data-tag-tip-hint="interactive ? '点击筛选同标签商家' : undefined"
    :role="interactive ? 'button' : undefined"
    :tabindex="interactive ? 0 : undefined"
    :data-action="interactive ? 'filter-prov-tag' : undefined"
    :data-prov-tag="interactive ? tag.key : undefined"
    @click="interactive ? handleActivate($event) : undefined"
    @keydown.enter.prevent="interactive ? handleActivate($event) : undefined"
    @keydown.space.prevent="interactive ? handleActivate($event) : undefined"
  >
    <TagSvgIcon :tone="tag.tone" />
    <span class="tag-txt">{{ tag.shortLabel }}</span>
  </span>
</template>
