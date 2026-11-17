# AppImage signing

The GitHub workflows build and publish Linux AppImages only. These builds are
unsigned and do not require signing certificates or certificate secrets.

Each GitHub Release includes `SHA256SUMS.txt` alongside the AppImages.
