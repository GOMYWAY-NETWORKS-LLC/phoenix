import filesize from 'filesize'
import join from 'join-path'
import moment from 'moment'
import fileTypeIconMappings from './fileTypeIconMappings.json'
import { mapActions, mapGetters } from 'vuex'
const { default: PQueue } = require('p-queue')

export default {
  filters: {
    fileSize (int) {
      if (int < 0) {
        return ''
      }
      if (isNaN(int)) {
        return '?'
      }
      return filesize(int, {
        round: 2
      })
    },

    roundNumber (int) {
      return parseInt(int.toFixed(0))
    }
  },
  data: () => ({
    selectedFile: '',
    changeFileName: false,
    fileToBeDeleted: '',
    newName: '',
    originalName: null,
    queue: new PQueue({ concurrency: 1 }),
    uploadFileUniqueId: 0
  }),
  computed: {
    ...mapGetters('Files', ['searchTerm', 'inProgress', 'files', 'selectedFiles', 'highlightedFile', 'activeFiles', 'publicLinkPassword']),
    ...mapGetters(['getToken', 'capabilities', 'fileSideBars']),

    _renameDialogTitle () {
      let translated

      if (!this.selectedFile.name) return null

      if (this.selectedFile.type === 'folder') {
        translated = this.$gettext('Rename folder %{name}')
      } else {
        translated = this.$gettext('Rename file %{name}')
      }
      return this.$gettextInterpolate(translated, { name: this.selectedFile.name }, true)
    },

    // Files lists
    selectedAll () {
      return this.selectedFiles.length === this.fileData.length && this.fileData.length !== 0
    },
    actions () {
      const actions = [
        {
          icon: 'edit',
          handler: this.changeName,
          ariaLabel: this.$gettext('Rename'),
          isEnabled: function (item, parent) {
            if (!parent.canRename()) {
              return false
            }
            return item.canRename()
          }
        },
        {
          icon: 'file_download',
          handler: this.downloadFile,
          ariaLabel: this.$gettext('Download'),
          isEnabled: function (item) {
            return item.canDownload()
          }
        },
        {
          icon: 'delete',
          ariaLabel: this.$gettext('Delete'),
          handler: this.deleteFile,
          isEnabled: function (item, parent) {
            if (!parent.canBeDeleted()) {
              return false
            }
            return item.canBeDeleted()
          }
        }
      ]
      for (const sideBar of this.fileSideBars) {
        if (sideBar.enabled !== undefined && !sideBar.enabled(this.capabilities)) {
          continue
        }
        if (sideBar.quickAccess) {
          actions.push({
            icon: sideBar.quickAccess.icon,
            ariaLabel: sideBar.quickAccess.ariaLabel,
            handler: this.openSideBar,
            handlerData: sideBar.app,
            isEnabled: function (item) {
              return true
            }
          })
        }
      }

      return actions
    },
    changeFileErrorMessage () {
      return this.checkNewName(this.newName)
    },
    _deleteDialogTitle () {
      return this.$gettext('Delete File/Folder')
    },
    $_ocDialog_isOpen () {
      return this.changeFileName || this.filesDeleteMessage !== ''
    },
    _sidebarOpen () {
      return this.highlightedFile !== null
    }
  },
  methods: {
    ...mapActions('Files', ['resetSearch', 'addFileToProgress', 'resetFileSelection', 'addFileSelection',
      'removeFileSelection', 'setOverwriteDialogTitle', 'setOverwriteDialogMessage', 'deleteFiles', 'renameFile',
      'setHighlightedFile', 'setFilesDeleteMessage', 'removeFileFromProgress']),
    ...mapActions(['showMessage']),

    formDateFromNow (date) {
      return moment(date).locale(this.$language.current).fromNow()
    },
    changeName (item) {
      this.changeFileName = !this.changeFileName
      if (typeof item === 'object') {
        this.originalName = item.name
        this.selectedFile = item
        this.newName = item.name
        item = this.newName
        return
      }
      if (this.selectedFile.name === item) {
        // The name has to be resetted a little while later to prevent
        // showing the error druing the fade out animation of dialog
        setTimeout(_ => {
          this.originalName = null
        }, 1000)
        return
      }

      this.renameFile({
        client: this.$client,
        file: this.selectedFile,
        newValue: item,
        publicPage: this.publicPage()
      }).then(setTimeout(_ => {
        this.originalName = null
      }, 1000)).catch(error => {
        let translated = this.$gettext('Error while renaming "%{file}"')
        if (error.statusCode === 423) {
          translated = this.$gettext('Error while renaming "%{file}" - the file is locked')
        }
        const title = this.$gettextInterpolate(translated, { file: this.selectedFile.name }, true)
        this.showMessage({
          title: title,
          status: 'danger'
        })
      })
    },
    fileTypeIcon (file) {
      if (file) {
        if (file.type === 'folder') {
          return 'folder'
        }
        const icon = fileTypeIconMappings[file.extension]
        if (icon) return `${icon}`
      }
      return 'x-office-document'
    },
    label (string) {
      const cssClass = ['uk-label']

      switch (parseInt(string)) {
        case 1:
          cssClass.push('uk-label-danger')
          break
        case 2:
          cssClass.push('uk-label-warning')
          break
        default:
          cssClass.push('uk-label-success')
      }

      return '<span class="' + cssClass.join(' ') + '">' + string + '</span>'
    },
    checkIfBrowserSupportsFolderUpload () {
      const el = document.createElement('input')
      el.type = 'file'
      return typeof el.webkitdirectory !== 'undefined' || typeof el.mozdirectory !== 'undefined' || typeof el.directory !== 'undefined'
    },
    checkIfElementExists (element) {
      const name = element.name || element
      return this.files.find((n) => {
        if (n.name === name) {
          return n
        }
      })
    },
    processDirectoryEntryRecursively (directory) {
      return this.$client.files.createFolder(this.rootPath + directory.fullPath).then(() => {
        const directoryReader = directory.createReader()
        const ctrl = this
        directoryReader.readEntries(function (entries) {
          entries.forEach(function (entry) {
            if (entry.isDirectory) {
              ctrl.processDirectoryEntryRecursively(entry)
            } else {
              entry.file(file => {
                ctrl.$_ocUpload(file, entry.fullPath, null, false)
              })
            }
          })
        })
      })
    },
    async $_ocUpload_addDropToQue (e) {
      const items = e.dataTransfer.items || e.dataTransfer.files

      // A list of files is being dropped ...
      if (items instanceof FileList) {
        this.$_ocUpload_addDirectoryToQue(e)
        return
      }
      for (let item of items) {
        item = item.webkitGetAsEntry()
        const exists = this.checkIfElementExists(item)
        if (item.isDirectory) {
          if (!exists) {
            this.processDirectoryEntryRecursively(item).then(() => {
              this.$emit('success', null, item.name)
            })
          } else {
            this.showMessage({
              title: this.$gettextInterpolate(this.$gettext('Folder %{folder} already exists.'), { folder: item.name }, true),
              status: 'danger'
            })
          }
        } else {
          if (!exists) {
            item.file(file => {
              this.$_ocUpload(file, item.fullPath)
            })
          } else {
            const translated = this.$gettext('File %{file} already exists.')
            this.setOverwriteDialogTitle(this.$gettextInterpolate(translated, { file: item.name }, true))
            this.setOverwriteDialogMessage(this.$gettext('Do you want to overwrite it?'))
            const overwrite = await this.$_ocUpload_confirmOverwrite()
            if (overwrite) {
              item.file(file => {
                this.$_ocUpload(file, item.fullPath, exists.etag)
              })
            }
            this.setOverwriteDialogMessage(null)
          }
        }
      }
    },
    async $_ocUpload_addFileToQue (e) {
      const files = e.target.files
      if (!files.length) return
      for (let i = 0; i < files.length; i++) {
        const exists = this.checkIfElementExists(files[i])
        if (!exists) {
          this.$_ocUpload(files[i], files[i].name)
          if ((i + 1) === files.length) this.$_ocUploadInput_clean()
          continue
        }

        const translated = this.$gettext('File %{file} already exists.')
        this.setOverwriteDialogTitle(this.$gettextInterpolate(translated, { file: files[i].name }, true))
        this.setOverwriteDialogMessage(this.$gettext('Do you want to overwrite it?'))
        const overwrite = await this.$_ocUpload_confirmOverwrite()
        if (overwrite === true) {
          this.$_ocUpload(files[i], files[i].name, exists.etag)
          if ((i + 1) === files.length) this.$_ocUploadInput_clean()
        } else {
          if ((i + 1) === files.length) this.$_ocUploadInput_clean()
        }
        this.setOverwriteDialogMessage(null)
      }
    },
    $_ocUpload_addDirectoryToQue (e) {
      if (this.isIE11()) {
        this.showMessage({
          title: this.$gettext('Upload failed'),
          desc: this.$gettext('Upload of a folder is not supported in Internet Explorer.'),
          status: 'danger'
        })
        return
      }

      const files = e.target.files || e.dataTransfer.files
      if (!files.length) return

      // Check if base directory exists
      let directoryPath = files[0].webkitRelativePath.replace('/' + files[0].name, '')
      const directoryName = directoryPath.split('/')[0]
      const directoryExists = this.checkIfElementExists(directoryName)

      if (directoryExists) {
        this.showMessage({
          title: this.$gettextInterpolate(this.$gettext('Folder %{folder} already exists.'), { folder: directoryName }, true),
          status: 'danger'
        })
      } else {
        // Get folder structure
        const directoriesToCreate = []
        for (const file of files) {
          this.$_addFileToUploadProgress(file)
          directoryPath = file.webkitRelativePath.replace('/' + file.name, '')

          if (directoriesToCreate.indexOf(directoryPath) > -1) {
            continue
          }

          const directories = directoryPath.split('/')
          for (let i = 0; i < directories.length; i++) {
            if (i === 0) {
              if (directoriesToCreate.indexOf(directories[0]) === -1) {
                directoriesToCreate.push(directories[0])
              }

              continue
            }

            const parentDirectory = directories.slice(0, i).join('/')
            const currentDirectory = `${parentDirectory}/${directories[i]}`

            if (directoriesToCreate.indexOf(currentDirectory) === -1) {
              directoriesToCreate.push(currentDirectory)
            }
          }
        }

        // Create folder structure
        const createFolderPromises = []
        const rootDir = directoriesToCreate[0]
        for (const directory of directoriesToCreate) {
          let p

          if (this.publicPage()) {
            p = this.queue.add(() => this.$client.publicFiles.createFolder(this.rootPath + directory))
          } else {
            p = this.queue.add(() => this.$client.files.createFolder(this.rootPath + directory))
          }

          createFolderPromises.push(p)
        }
        // Upload files
        const uploadPromises = []
        Promise.all(createFolderPromises).then(() => {
          for (const file of files) {
            uploadPromises.push(this.$_ocUpload(file, file.webkitRelativePath, null, false, false))
          }
          // once all files are uploaded we emit the success event
          Promise.all(uploadPromises).then(() => {
            this.$emit('success', null, rootDir)
            this.$_ocUploadInput_clean()
          })
        })
      }
    },
    $_ocUpload_confirmOverwrite () {
      return new Promise(resolve => {
        const confirmButton = document.querySelector('#files-overwrite-confirm')
        const cancelButton = document.querySelector('#files-overwrite-cancel')
        confirmButton.addEventListener('click', _ => {
          resolve(true)
        })
        cancelButton.addEventListener('click', _ => {
          resolve(false)
        })
      })
    },

    /**
     * Adds file into the progress queue and assigns it unique id
     * @param {Object} file File which is to be added into progress
     */
    $_addFileToUploadProgress (file) {
      file.id = this.uploadFileUniqueId
      this.uploadFileUniqueId++
      this.addFileToProgress(file)
    },

    $_ocUpload (file, path, overwrite = null, emitSuccess = true, addToProgress = true) {
      let basePath = this.path || ''
      let relativePath = path
      if (addToProgress) {
        this.$_addFileToUploadProgress(file)
      }

      let promise
      if (this.publicPage()) {
        // strip out public link token from path
        basePath = basePath.substr(basePath.indexOf('/') + 1) || ''
        relativePath = join(basePath, relativePath)
        // FIXME: token not defined.
        // it seems that .token is for files drop and .item for public page... needs refactoring for consistency!
        promise = this.$client.publicFiles.putFileContents(this.$route.params.token, relativePath, this.publicLinkPassword, file, {
          onProgress: (progress) => {
            this.$_ocUpload_onProgress(progress, file)
          },
          overwrite: overwrite
        })
      } else {
        basePath = this.path || ''
        relativePath = join(basePath, relativePath)
        promise = this.$client.files.putFileContents(relativePath, file, {
          onProgress: (progress) => {
            this.$_ocUpload_onProgress(progress, file)
          },
          overwrite: overwrite
        })
      }

      promise.then(e => {
        this.removeFileFromProgress(file)
        if (emitSuccess) {
          this.$emit('success', e, file)
        }
      }).catch(e => {
        this.removeFileFromProgress(file)
        this.$emit('error', e)
      })
    },
    $_ocUpload_onProgress (e, file) {
      const progress = parseInt(e.loaded * 100 / e.total)
      this.$emit('progress', {
        id: file.id,
        fileName: file.name,
        progress
      })
    },
    $_ocUploadInput_clean () {
      const input = this.$refs.input
      if (input) {
        input.value = ''
      }
    },

    // Files lists
    toggleAll () {
      if (this.selectedFiles.length && this.selectedFiles.length === this.fileData.length) {
        this.resetFileSelection()
      } else {
        const selectedFiles = this.fileData.slice()
        for (const item of selectedFiles) {
          if (!this.selectedFiles.includes(item)) {
            this.addFileSelection(item)
          }
        }
      }
    },
    openFileActionBar (file) {
      this.$emit('FileAction', file)
    },
    checkNewName (name) {
      if (/[/]/.test(name)) return this.$gettext('The name cannot contain "/"')

      if (name === '.') return this.$gettext('The name cannot be equal to "."')

      if (name === '..') return this.$gettext('The name cannot be equal to ".."')

      if (/\s+$/.test(name)) return this.$gettext('The name cannot end with whitespace')

      const exists = this.activeFiles.find((n) => {
        if (n.name === name && this.originalName !== name) {
          return n
        }
      })

      if (exists) {
        const translated = this.$gettext('The name "%{name}" is already taken')
        return this.$gettextInterpolate(translated, { name: name }, true)
      }
      return null
    },
    deleteFile (file) {
      this.fileToBeDeleted = file
      const translated = this.$gettext('Please confirm the deletion of %{ fileName }')
      this.setFilesDeleteMessage(this.$gettextInterpolate(translated, { fileName: file.name }, true))
    },
    openSideBar (file, sideBarName) {
      this.$emit('sideBarOpen', file, sideBarName)
    },
    reallyDeleteFiles () {
      const files = this.fileToBeDeleted ? [this.fileToBeDeleted] : this.selectedFiles
      this.deleteFiles({
        client: this.$client,
        files: files,
        publicPage: this.publicPage(),
        $gettext: this.$gettext,
        $gettextInterpolate: this.$gettextInterpolate
      }).then(() => {
        this.fileToBeDeleted = ''
        this.setFilesDeleteMessage('')
        this.setHighlightedFile(null)
      }).catch(error => {
        console.log(error)
      })
    },
    _rowClasses (item) {
      if (this.highlightedFile && item.id === this.highlightedFile.id) {
        return 'file-row uk-active'
      }
      return 'file-row'
    },
    selectRow (item, event) {
      if (event.target.tagName !== 'TD') {
        return
      }

      if (item.status && (item.status === 1 || item.status === 2)) return

      event.stopPropagation()
      this.setHighlightedFile(item)
    },
    navigateTo (param) {
      if (this.searchTerm !== '' && this.$route.params.item === param) {
        this.resetSearch()
      }
      let route = 'files-list'
      if (this.publicPage()) {
        route = 'public-files'
      }
      this.$router.push({
        name: route,
        params: {
          item: param
        }
      })
    },
    openFileAction (action, filePath) {
      if (action.newTab) {
        const path = this.$router.resolve({ name: action.routeName, params: { filePath: filePath } }).href
        const url = window.location.origin + '/' + path
        const target = `${action.routeName}-${filePath}`
        const win = window.open(url, target)
        // in case popup is blocked win will be null
        if (win) {
          win.focus()
        }
        return
      }
      // TODO: rewire code below ....
      const appId = action.app
      // TODO path to state
      this.$router.push({
        name: appId
      })
    }
  }
}
