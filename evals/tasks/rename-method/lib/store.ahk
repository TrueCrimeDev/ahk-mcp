class Store {
  __New(path) {
    this.path := path
    this.items := []
  }

  Load() {
    if FileExist(this.path)
      this.items := StrSplit(FileRead(this.path), "`n")
    return this
  }

  Count => this.items.Length
}
