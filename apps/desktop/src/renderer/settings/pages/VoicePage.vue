<script setup lang="ts">
/**
 * 语音设置页（docs/06 §13、docs/08 §1/§5，BetaV2 六页 IA）：
 * 「语音合成（TTS）」与「语音输入（STT）」两个区组（spec §9）。
 *
 * TTS 内容由原 `TtsPage.vue` 整体迁入（`TtsSection`），STT 为 BetaV2 新增（`SttSection`）；
 * 两组各自折叠、各自保存，`tts.*` / `stt.*` 锚点与重构前一致。
 * 两套 provider 同构但独立：语音输入与语音输出的可用性互不绑定。
 */
import SttSection from '../components/SttSection.vue'
import TtsSection from '../components/TtsSection.vue'
</script>

<template>
  <section class="page">
    <header>
      <h1 class="page-title">语音</h1>
      <p class="page-sub">
        朗读回复（TTS）与语音输入（STT）。支持任何 OpenAI 兼容服务；凭据加密保存在本机。
      </p>
    </header>

    <TtsSection />
    <SttSection />
  </section>
</template>
