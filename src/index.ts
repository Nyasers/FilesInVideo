import './style.css';
import { createApp } from 'vue';
import App from './App.vue';
import { registerSw } from './sw-client';

createApp(App).mount('#app');
registerSw();
