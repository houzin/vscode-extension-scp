#!/bin/bash

#  编译和发布
echo -e "${YELLOW}开始编译和发布...${NC}"
npm run vscode:prepublish
vsce publish minor
