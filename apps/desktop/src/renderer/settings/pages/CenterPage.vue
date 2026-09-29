<script setup lang="ts">
/**
 * Aurora Center 设置页（docs/12 §6/§7）：与桌面端配套的远程控制服务器，
 * 桌面端作为客户端连接它。三个区组（组织方式与 VoicePage 一致：薄页面 + 区组组件）：
 * 连接设置（地址 / 账号登录）/ 远程控制许可（本机最终闸门）/ 连接状态（5 秒轮询）。
 *
 * `center.*` 整组在 `SETTINGS_READONLY_PREFIXES` 黑名单里：AI 的 set_setting 改不动，
 * 本页走 settings:update 不受影响；登录凭据只经 `center:login` 由主进程写入凭据链路。
 */
import CenterConnectionSection from '../components/CenterConnectionSection.vue'
import CenterPermissionsSection from '../components/CenterPermissionsSection.vue'
import CenterStatusSection from '../components/CenterStatusSection.vue'
</script>

<template>
  <section class="page">
    <header>
      <h1 class="page-title">Aurora Center</h1>
      <p class="page-sub">
        用 Center 账号登录后自动连接，同一账号可在网页端远程控制本机；配置与凭据只存本机。
      </p>
    </header>

    <CenterConnectionSection />
    <CenterPermissionsSection />
    <CenterStatusSection />
  </section>
</template>
