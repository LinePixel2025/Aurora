'use strict'

const api = window.auroraPlugin
const greeting = document.getElementById('greeting')
const text = document.getElementById('text')
const hint = document.getElementById('hint')

api
  .request('init')
  .then((result) => {
    const data = result && result.data ? result.data : {}
    if (typeof data.greeting === 'string' && data.greeting !== '') {
      greeting.textContent = data.greeting
    }
  })
  .catch(() => {})

document.getElementById('save').addEventListener('click', () => {
  hint.textContent = ''
  api.request('save', { text: text.value }).catch((error) => {
    hint.textContent = error && error.message ? error.message : String(error)
  })
})

document.getElementById('cancel').addEventListener('click', () => {
  api.request('cancel').catch(() => {})
})

text.focus()
