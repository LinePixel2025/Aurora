import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import type { CenterOfficialModelCatalog } from '@aurora/shared/browser'

const catalog = ref<CenterOfficialModelCatalog | null>(null)
let consumers = 0
let offChanged: (() => void) | null = null

async function refresh(): Promise<void> {
  const result = await window.aurora.center.modelServices()
  if (result.ok) catalog.value = result.value
}

export function useCenterOfficialCatalog(): { catalog: Ref<CenterOfficialModelCatalog | null> } {
  onMounted(() => {
    consumers += 1
    if (offChanged === null) {
      offChanged = window.aurora.center.onModelServicesChanged((next) => {
        catalog.value = next
      })
      void refresh()
    }
  })
  onUnmounted(() => {
    consumers = Math.max(0, consumers - 1)
    if (consumers === 0 && offChanged !== null) {
      offChanged()
      offChanged = null
    }
  })
  return { catalog }
}
