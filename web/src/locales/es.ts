import en from './en'
import type { LocaleStrings } from './en'

const es: LocaleStrings = {
  ...en,
  // ── Glasses display: screen titles ──
  titleTelegram: 'Telegram',
  titleTelegramLogin: 'Inicio de Telegram',
  titleTopics: 'Temas',
  titleChats: 'Chats',
  titleNewTelegram: 'Nuevo Telegram',
  titleRecordingReply: 'Grabando respuesta',
  titleRecording: 'Grabando',
  titleTranscribing: 'Transcribiendo',
  titleConfirmReply: 'Confirmar respuesta',
  titleSendingReply: 'Enviando respuesta',
  titleReplySent: 'Respuesta enviada',
  titleError: 'Error',

  // ── Glasses display: status pills / footer labels ──
  statusSent: 'Enviado',
  statusOlderMessages: 'Más antiguos',
  statusNewerMessages: 'Más recientes',
  statusNewerCount: '{n} más nuevos',
  dividerLastRead: 'último leído',
  statusNoOlderMessages: 'Sin más mensajes',
  statusNewReply: 'Nueva respuesta',
  statusLoadingOlderMessages: 'Cargando más antiguos...',
  statusLoadingMessages: 'Cargando mensajes...',
  footerSwipeChats: 'Deslizar chats | Tocar para abrir',
  footerTapToOpenTopic: 'TOCAR PARA ABRIR TEMA',
  footerSwipeScroll: 'Deslizar | Mantener grabar | Doble toque atrás',
  footerClickStop: 'Soltar parar | Doble toque cancelar',
  footerSwipeSelect: 'Deslizar seleccionar | Tocar confirmar',
  footerDoubleClickDismiss: 'Doble toque para cerrar',
  footerLoadingMessages: 'Cargando mensajes...',
  typingSuffix: 'escribiendo\u2026',

  // ── Glasses display: content / labels ──
  bodyNewMessage: 'Nuevo mensaje',
  bodyClickToOpen: 'Tocar para abrir.',
  bodyPressToRetry: 'Tocar para reintentar. Doble toque atrás.',
  bodyConvertingVoice: 'Convirtiendo voz...',
  confirmSend: 'Enviar',
  confirmCancel: 'Cancelar',
  senderMe: 'Yo',
  senderUnknown: 'Desconocido',
  messageUnsupported: '[Mensaje no compatible]',
  sanitizeRed: '[rojo]',
  sanitizeYellow: '[amarillo]',
  sanitizeGreen: '[verde]',

  // ── Phone UI: ChatScreen state descriptions ──
  phoneScreenOff: 'Pantalla apagada. Doble toque para activar.',
  phoneRecording: 'Grabando en las gafas\u2026',
  phoneTranscribing: 'Transcribiendo respuesta\u2026',
  phoneConfirmOnGlasses: 'Confirmar respuesta en gafas: ',
  phoneSendingReply: 'Enviando respuesta\u2026',
  phoneReplySent: 'Respuesta enviada.',
  phoneNoMessages: 'Sin mensajes aún.',
  phoneOpenChatToSend: 'Abre un chat o tema para enviar una respuesta.',
  phoneSendFailed: 'Envío fallido',
  phoneCodeSendFailed: 'No se pudo enviar el código',
  phoneCodeVerifyFailed: 'No se pudo verificar el código',

  // ── Phone UI: ChatScreen headings / labels ──
  phoneChatsHeading: 'Chats',
  phoneTelegramLoginHeading: 'Inicio de Telegram',
  phoneTelegramSessionHeading: 'Sesión de Telegram',
  phoneNewTelegramHeading: 'Nuevo Telegram',
  phoneErrorHeading: 'Error',
  phoneVerificationCode: 'Código de verificación',
  phoneMobileNumber: 'Número móvil con código de país',
  phoneSend: 'Enviar',
  phoneVerifyCode: 'Verificar Código',
  phoneSendLoginCode: 'Enviar Código',
  phoneCurrentThread: 'Hilo actual',
  phoneComposerPlaceholder: 'Escribe una respuesta de Telegram...',
  phoneSending: 'Enviando...',
  phoneVerifying: 'Verificando...',
  phoneSendingLoginCode: 'Enviando...',
  phoneOpenThread: 'Abrir Hilo',
  phoneRetry: 'Reintentar',
  phoneActionsAria: 'Acciones del teléfono',
  phoneOlderUp: 'Anterior / Subir',
  phoneNewerDown: 'Siguiente / Bajar',
  phoneBackSleep: 'Atrás / Dormir',

  // ── Phone UI: SettingsScreen ──
  phoneSettingsHeading: 'Ajustes',
  phoneAlreadyConnected: 'Ya conectado',
  phoneNotConnected: 'No conectado',
  phoneConfigured: 'Configurado',
  phoneRequired: 'Requerido',
  phoneStoredOnPhone: 'Almacenado solo en este teléfono',
  phoneBackendSessionActive: 'Sesión del backend activa',
  phoneNotLoggedIn: 'No has iniciado sesión',
  phoneSaveSettings: 'Guardar Ajustes',
  phoneSaved: 'Guardado',
  phoneReset: 'Restablecer',
  phoneDisconnectTelegram: 'Desconectar Telegram',
  phoneDisconnecting: 'Desconectando...',

  // ── Phone UI: App shell ──
  phoneAppTitle: 'TeleGlance',
  phoneSettingsTab: 'Ajustes',
  phoneBack: 'Atrás',
  phoneBackToChat: 'Volver al chat',
  phoneOpenSettings: 'Abrir ajustes',
  phoneSetupRequired:
    'Se requiere el secreto compartido del backend, el ID de API de Telegram y el hash de API de Telegram. Complétalos en Ajustes.',

  // ── Error / auth messages ──
  errorBackendUnreachable:
    'El backend no es accesible. Introduce la URL del backend en Ajustes.',
  errorBackendTimeout:
    'La solicitud al backend expiró. El servidor podría estar inaccesible.',
  errorEncryptedAuthMissing:
    'Faltan credenciales de autenticación. Complétalas en Ajustes.',
  errorSharedSecretRequired:
    'Se requiere el secreto compartido del backend.',
  errorEncryptedMalformed: 'La respuesta cifrada del backend está mal formada.',
  errorWebCryptoRequired:
    'La autenticación cifrada requiere WebCrypto.',
  errorUpdateStreamUnavailable: 'El flujo de actualizaciones no está disponible.',
  errorUpdateStreamFailed: 'El flujo de actualizaciones falló.',
  errorStarting: 'Iniciando...',
  errorStartupFailed: 'El inicio falló.',
  errorUnexpected: 'Ocurrió un error inesperado.',

  // ── Auth screen messages ──
  authNeedsSetup:
    'Abre Ajustes y completa la URL del backend, el Secreto Compartido, el ID de API de Telegram y el Hash de API de Telegram.',
  authSignedOut: 'Toca para iniciar sesión con tu número de teléfono.',
  authPhonePending: 'Introduce el código de verificación enviado a tu teléfono.',

  // ── Settings UI ──
  settingsTelegramSection: 'Telegram',
  settingsBackendSection: 'Backend',
  settingsVoiceSection: 'Voz',
  settingsLanguageSection: 'Idioma',
  settingsBuildSection: 'Compilación',
  settingsStatusLabel: 'Estado',
  settingsCredentialsLabel: 'Credenciales',
  settingsSharedSecretLabel: 'Secreto compartido',
  settingsSessionLabel: 'Sesión',
  settingsStatusConnected: 'Conectado',
  settingsStatusNotConnected: 'No conectado',
  settingsConfigured: 'Configurado',
  settingsRequired: 'Requerido',
  settingsStoredOnPhone: 'Almacenado solo en este teléfono',
  settingsBackendSession: 'Sesión del backend activa',
  settingsNotLoggedIn: 'No has iniciado sesión',
  settingsSetupHidden:
    'Los detalles de configuración están ocultos porque Telegram está conectado.',
  settingsSetupExpand:
    'Expande para añadir credenciales de la API de Telegram desde my.telegram.org.',
  settingsChangeSetup: 'Cambiar configuración de Telegram',
  settingsSetupInstructions: 'Instrucciones de configuración de Telegram',
  settingsSetupHint:
    'Los usuarios nuevos necesitan sus propias credenciales de la API de Telegram.',
  settingsSetupStep1: 'Abre my.telegram.org e inicia sesión con tu número de teléfono.',
  settingsSetupStep2: 'Abre las herramientas de desarrollo de API y crea una app.',
  settingsSetupStep3: 'Pega el ID de API y el hash de API abajo, luego guarda.',
  settingsSetupStep4:
    'Crea un secreto compartido del backend y pégalo en la configuración del Backend.',
  settingsSetupStep5:
    'Introduce tu número de móvil con código internacional para recibir un código.',
  settingsTelegramApiId: 'ID de API de Telegram',
  settingsTelegramApiHash: 'Hash de API de Telegram',
  settingsDisconnectTelegram: 'Desconectar Telegram',
  settingsDisconnecting: 'Desconectando...',
  settingsBackendHint:
    'Ejecuta tu propio backend desde este repositorio. Enlace: ',
  settingsBackendSetup: 'Instrucciones de configuración del backend',
  settingsBackendUrl: 'URL del Backend',
  settingsBackendSecret: 'Secreto compartido del backend',
  settingsBackendSecretHint:
    'Requerido. El mismo valor que TELEGLANCE_SHARED_SECRET en el .env del backend.',
  settingsBackendSecretPlaceholder: 'Requerido',
  settingsSharedBackendSecretPlaceholder: 'Not used for testing backend',
  settingsSharedBackendWarning: 'Use https://teleglance.akira-os.net only for testing. No user secret is needed for this backend. The testing URL may be unstable; switch to your own backend before relying on it.',
  settingsSttUrl: 'URL del Servidor STT (Opcional)',
  settingsSttHint:
    'Déjalo en blanco para usar la URL del backend.',
  settingsDebugEvents: 'Registro de eventos de depuración',
  settingsDebugEventsHint:
    'Desactivado para uso normal.',
  settingsRecMinDuration: 'Duración mínima de grabación (ms)',
  settingsAdvancedPolling: 'Actualización avanzada',
  settingsAdvancedPollingHint:
    'Temporizadores de respaldo para eventos perdidos.',
  settingsChatPoll: 'Actualización de chat (ms)',
  settingsMessagePoll: 'Actualización de mensajes (ms)',
  settingsLanguageLabel: 'Idioma',
  settingsLanguageHint: 'Cambia todo el texto de la interfaz de las gafas y las etiquetas del teléfono.',
  settingsBuildVersion: 'Versión de compilación',
  settingsApiUrl: 'URL actual de la API',
  settingsSave: 'Guardar Ajustes',
  settingsSaved: 'Guardado',
  settingsReset: 'Restablecer',
  settingsClearCache: 'Borrar caché',
  settingsCacheCleared: 'Caché borrada',
  settingsTestConnection: 'Probar conexión',
  settingsTesting: 'Probando...',
  settingsTestHealthOk: 'Servidor accesible',
  settingsTestHealthFail: 'Servidor no accesible',
  settingsTestSessionOk: 'Clave aceptada, Telegram con sesión iniciada',
  settingsTestSessionNotLoggedIn: 'Clave aceptada, Telegram sin sesión todavía',
  settingsTestSessionFail: 'El servidor rechazó la solicitud',
  settingsTestSessionSkipped: 'Omitido (servidor no accesible)',
  phoneForwardedFrom: 'Reenviado de',
  phonePhoto: 'foto',
  phoneSticker: 'sticker',

  // ── Bridge ──
  bridgeEmptyList: 'Vacío',
}
export default es
